"""Bounded x402 v2 EIP-3009 client for the CheckTokenSafety example.

One instance owns a finite in-memory session budget. Failed/pending signatures
remain reserved; a new instance or process is not a wallet-wide spending limit.
"""
from __future__ import annotations

import base64
import json
import os
import re
import secrets
import threading
import time
from concurrent.futures import Future, TimeoutError as FutureTimeout
from dataclasses import dataclass
from typing import Callable, TypeVar
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter
from eth_account import Account
from urllib3.exceptions import HTTPError as UrllibHTTPError, ReadTimeoutError

HOSTED_URL = "https://agenttoll.app"
HOSTED_RECIPIENT = "0xe55359021a6a22d8385b827405991c56075f56f8"
SAFETY_AMOUNT = 3000  # Registered /api/base/safety/{address} price, micro-USDC.
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
NETWORKS = {
    "base": ("eip155:8453", 8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin"),
    "base-sepolia": ("eip155:84532", 84532, "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC"),
}
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
T = TypeVar("T")


class PaymentError(RuntimeError):
    pass


class PaymentTimeout(PaymentError):
    pass


def _amount(value: str | int | float, label: str) -> int:
    text = str(value)
    if not re.fullmatch(r"(?:0|[1-9]\d{0,15})(?:\.\d{1,6})?", text):
        raise PaymentError(f"{label} must be a nonnegative USDC amount with at most six decimals.")
    whole, _, fraction = text.partition(".")
    result = int(whole) * 1_000_000 + int(fraction.ljust(6, "0"))
    if result > 9_007_199_254_740_991:
        raise PaymentError(f"{label} is too large.")
    return result


def _usdc(amount: int) -> str:
    return f"{amount // 1_000_000}.{amount % 1_000_000:06d}"


def _origin(value: str) -> str:
    if not isinstance(value, str) or re.search(r"[\x00-\x20\x7f\\]", value):
        raise PaymentError("API URL must be an HTTP(S) origin without credentials or a path.")
    try:
        url = urlsplit(value)
        if (url.scheme not in ("http", "https") or not url.hostname or url.username is not None
                or url.password is not None or url.path not in ("", "/") or url.query or url.fragment
                or "?" in value or "#" in value):
            raise ValueError()
        host = url.hostname.lower().encode("idna").decode("ascii")
        if url.scheme == "http" and host not in ("localhost", "127.0.0.1", "::1"):
            raise PaymentError("Remote payment origins must use HTTPS; HTTP is allowed only on localhost.")
        host = f"[{host}]" if ":" in host else host
        port = url.port
        suffix = f":{port}" if port is not None and port != (443 if url.scheme == "https" else 80) else ""
        return f"{url.scheme}://{host}{suffix}"
    except (ValueError, UnicodeError):
        raise PaymentError("API URL must be an HTTP(S) origin without credentials or a path.") from None


class _Deadline:
    def __init__(self, timeout_ms: int, cancellation: threading.Event | None):
        self.end = time.monotonic() + timeout_ms / 1000
        self.cancellation = cancellation
        self.stopped = threading.Event()

    def check(self) -> None:
        if self.cancellation is not None and self.cancellation.is_set():
            self.stopped.set()
            raise PaymentError("Payment cancelled; inspect the payment budget before retrying.")
        if self.stopped.is_set() or time.monotonic() >= self.end:
            self.stopped.set()
            raise PaymentTimeout("Payment timed out; inspect the payment budget before retrying.")

    def remaining(self) -> float:
        self.check()
        return max(0.001, self.end - time.monotonic())

    def run(self, work: Callable[[], T]) -> T:
        self.check()
        future: Future[T] = Future()

        def worker() -> None:
            try:
                self.check()
                future.set_result(work())
            except BaseException as error:
                future.set_exception(error)

        # DNS/wallet operations cannot always be interrupted by Python. The
        # caller still has a total deadline, and late work checks it before retry.
        threading.Thread(target=worker, daemon=True).start()
        while True:
            self.check()
            try:
                result = future.result(timeout=min(0.05, self.remaining()))
                self.check()
                return result
            except FutureTimeout:
                continue


class _DeadlineAdapter(HTTPAdapter):
    """Check the operation at the transport boundary, including after DNS/TLS.

    A Requests timeout does not interrupt DNS. Guard each manager's own
    connection classes so a late connection cannot send payment headers. Keep
    existing HTTP, HTTPS and proxy behavior without changing global pools.
    """

    def __init__(self, deadline: _Deadline):
        self.deadline = deadline
        super().__init__(max_retries=0)

    def _guard(self, manager) -> None:
        deadline = self.deadline

        def guarded_pool(pool):
            class Connection(pool.ConnectionCls):
                def connect(self):
                    deadline.check()
                    try:
                        super().connect()
                        deadline.check()
                    except BaseException:
                        self.close()
                        raise

                def send(self, data):
                    deadline.check()
                    # A new socket invokes guarded connect() before sending;
                    # an already-connected socket still checks every write.
                    return super().send(data)

            class Pool(pool):
                ConnectionCls = Connection

            return Pool

        manager.pool_classes_by_scheme = {
            scheme: guarded_pool(pool) for scheme, pool in manager.pool_classes_by_scheme.items()
        }

    def init_poolmanager(self, *args, **kwargs):
        super().init_poolmanager(*args, **kwargs)
        self._guard(self.poolmanager)

    def proxy_manager_for(self, proxy, **kwargs):
        existing = proxy in self.proxy_manager
        manager = super().proxy_manager_for(proxy, **kwargs)
        if not existing:
            self._guard(manager)
        return manager


@dataclass(frozen=True)
class PaymentResponse:
    status: int
    body: bytes
    headers: dict[str, str]

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    @property
    def text(self) -> str:
        return self.body.decode("utf-8")


class BoundedSafetyClient:
    def __init__(self, private_key: str | None = None, *, base_url: str = HOSTED_URL,
                 recipient: str | None = None, network: str = "base",
                 total_budget_usdc: str | int | float = "1",
                 max_per_call_usdc: str | int | float | None = None, timeout_ms: int = 30_000):
        if network not in NETWORKS:
            raise PaymentError("Payment network must be base or base-sepolia.")
        if type(timeout_ms) is not int or not 1 <= timeout_ms <= 300_000:
            raise PaymentError("Payment timeout must be an integer from 1 to 300000 milliseconds.")
        self.origin = _origin(base_url)
        self.recipient = recipient if recipient is not None else (HOSTED_RECIPIENT if self.origin == HOSTED_URL else None)
        if (not isinstance(self.recipient, str) or not ADDRESS.fullmatch(self.recipient)
                or int(self.recipient[2:], 16) == 0):
            raise PaymentError("An explicit valid trusted recipient is required for a custom API host.")
        self.recipient = self.recipient.lower()
        self.network, self.chain_id, self.asset, self.domain_name = NETWORKS[network]
        self.total = _amount(total_budget_usdc, "Total budget")
        self.ceiling = min(SAFETY_AMOUNT, _amount(max_per_call_usdc, "Per-call ceiling")) if max_per_call_usdc is not None else SAFETY_AMOUNT
        self.timeout_ms = timeout_ms
        self.account = Account.from_key(private_key) if private_key else None
        self._lock = threading.Lock()
        self._spent = 0
        self._reserved = 0

    @classmethod
    def from_env(cls) -> "BoundedSafetyClient":
        base_url = os.getenv("AGENTTOLL_URL", HOSTED_URL)
        local = urlsplit(base_url).hostname in ("localhost", "127.0.0.1", "::1")
        try:
            timeout = int(os.getenv("AGENTTOLL_TIMEOUT_MS", "30000"))
        except ValueError:
            raise PaymentError("AGENTTOLL_TIMEOUT_MS must be an integer.") from None
        return cls(
            private_key=os.getenv("EVM_PRIVATE_KEY") or os.getenv("AGENT_PRIVATE_KEY"),
            base_url=base_url,
            recipient=os.getenv("AGENTTOLL_RECIPIENT") or (os.getenv("ADDRESS") if local else None),
            network=os.getenv("AGENTTOLL_NETWORK") or (os.getenv("NETWORK", "base-sepolia") if local else "base"),
            total_budget_usdc=os.getenv("AGENTTOLL_BUDGET_USDC", "1"),
            max_per_call_usdc=os.getenv("AGENTTOLL_MAX_PER_CALL_USDC"), timeout_ms=timeout,
        )

    def get_payment_budget(self) -> dict:
        with self._lock:
            return {"totalUsdc": _usdc(self.total), "spentUsdc": _usdc(self._spent),
                    "reservedUsdc": _usdc(self._reserved),
                    "remainingUsdc": _usdc(self.total - self._spent - self._reserved),
                    "apiOrigin": self.origin, "recipient": self.recipient, "network": self.network,
                    "asset": self.asset, "ceilingUsdc": _usdc(self.ceiling),
                    "timeoutMs": self.timeout_ms, "canSign": self.account is not None}

    def _url(self, address: str) -> str:
        if not isinstance(address, str) or not ADDRESS.fullmatch(address) or int(address[2:], 16) == 0:
            raise PaymentError("Token address must be a nonzero 0x-prefixed 40-digit address.")
        return f"{self.origin}/api/base/safety/{address.lower()}"

    def _request(self, url: str, deadline: _Deadline, signature: str | None = None) -> PaymentResponse:
        deadline.check()
        headers = {"PAYMENT-SIGNATURE": signature} if signature else {}
        try:
            # Separate sessions keep simultaneous tool calls independent.
            with requests.Session() as session:
                adapter = _DeadlineAdapter(deadline)
                session.mount("http://", adapter)
                session.mount("https://", adapter)
                with session.get(url, headers=headers, allow_redirects=False, stream=True,
                                 timeout=(deadline.remaining(), deadline.remaining())) as response:
                    deadline.check()
                    if 300 <= response.status_code < 400 or response.url != url:
                        raise PaymentError("Payment requests cannot redirect or change the requested resource.")
                    response_headers = {key.lower(): value for key, value in response.headers.items()}
                    # A quote is carried in the header. Do not download an arbitrary quote body.
                    if response.status_code == 402:
                        return PaymentResponse(402, b"", response_headers)
                    body = bytearray()
                    while True:
                        deadline.check()
                        chunk = response.raw.read1(65_536, decode_content=True)
                        deadline.check()
                        if not chunk:
                            break
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise PaymentError("Oversized API response.")
                    return PaymentResponse(response.status_code, bytes(body), response_headers)
        except (requests.Timeout, ReadTimeoutError):
            raise PaymentTimeout("Payment HTTP request timed out; inspect the payment budget before retrying.") from None
        except (requests.RequestException, UrllibHTTPError):
            raise PaymentError("Payment HTTP request failed; inspect the payment budget before retrying.") from None

    def _quote(self, response: PaymentResponse, url: str) -> tuple[dict, int]:
        header = response.headers.get("payment-required")
        if not isinstance(header, str) or not header or len(header) > 32_768:
            raise PaymentError("Missing or oversized x402 payment quote header.")
        try:
            value = json.loads(base64.b64decode(header, validate=True))
        except (ValueError, UnicodeError):
            raise PaymentError("Malformed x402 payment quote header.") from None
        if (not isinstance(value, dict) or type(value.get("x402Version")) is not int or value["x402Version"] != 2
                or not isinstance(value.get("resource"), dict) or value["resource"].get("url") != url
                or not isinstance(value.get("accepts"), list) or len(value["accepts"]) != 1):
            raise PaymentError("Unrecognized x402 v2 quote or mismatched resource.")
        accepted = value["accepts"][0]
        if not isinstance(accepted, dict) or accepted.get("scheme") != "exact" or accepted.get("network") != self.network:
            raise PaymentError("Quote must use exact payments on the configured network.")
        if not isinstance(accepted.get("asset"), str) or accepted["asset"].lower() != self.asset.lower():
            raise PaymentError("Quote must use the configured network's USDC contract.")
        if not isinstance(accepted.get("payTo"), str) or accepted["payTo"].lower() != self.recipient:
            raise PaymentError("Quote recipient differs from the trusted receiver.")
        amount = accepted.get("amount")
        if not isinstance(amount, str) or not re.fullmatch(r"[1-9]\d{0,15}", amount):
            raise PaymentError("Quote amount must be a positive integer in micro-USDC.")
        if int(amount) > self.ceiling:
            raise PaymentError(f"Quote exceeds the {_usdc(self.ceiling)} USDC endpoint price ceiling.")
        lifetime = accepted.get("maxTimeoutSeconds")
        if type(lifetime) is not int or not 1 <= lifetime <= 300:
            raise PaymentError("Quote authorization lifetime must be between 1 and 300 seconds.")
        extra = accepted.get("extra")
        if (not isinstance(extra, dict) or extra.get("name") != self.domain_name or extra.get("version") != "2"
                or extra.get("assetTransferMethod", "eip3009") != "eip3009"
                or extra.get("paymentFlow", "authorization") != "authorization"):
            raise PaymentError("Unrecognized USDC signing domain or transfer method.")
        # Unknown quote data/extensions are never forwarded to a signing library.
        requirement = {"scheme": "exact", "network": self.network, "amount": amount,
                       "asset": accepted["asset"], "payTo": accepted["payTo"], "maxTimeoutSeconds": lifetime,
                       "extra": {"name": self.domain_name, "version": "2"}}
        for field in ("assetTransferMethod", "paymentFlow"):
            if field in extra:
                requirement["extra"][field] = extra[field]
        return {"x402Version": 2, "resource": {"url": url}, "accepts": [requirement]}, int(amount)

    def get_payment_quote(self, address: str, cancellation: threading.Event | None = None) -> dict:
        url = self._url(address)
        deadline = _Deadline(self.timeout_ms, cancellation)

        def work() -> dict:
            response = self._request(url, deadline)
            if response.status != 402:
                raise PaymentError(f"Expected a payment quote, received HTTP {response.status}.")
            quote, amount = self._quote(response, url)
            return {"amountUsdc": _usdc(amount), "ceilingUsdc": _usdc(self.ceiling), "quote": quote}

        return deadline.run(work)

    def _sign(self, quote: dict) -> str:
        accepted = quote["accepts"][0]
        authorization = {"from": self.account.address, "to": self.recipient, "value": accepted["amount"],
                         "validAfter": "0", "validBefore": str(int(time.time()) + accepted["maxTimeoutSeconds"]),
                         "nonce": "0x" + secrets.token_hex(32)}
        types = {"TransferWithAuthorization": [
            {"name": "from", "type": "address"}, {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"}, {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"}, {"name": "nonce", "type": "bytes32"},
        ]}
        signed = self.account.sign_typed_data(
            domain_data={"name": self.domain_name, "version": "2", "chainId": self.chain_id, "verifyingContract": self.asset},
            message_types=types, message_data=authorization,
        )
        payload = {"x402Version": 2, "resource": quote["resource"], "accepted": accepted,
                   "payload": {"authorization": authorization, "signature": "0x" + bytes(signed.signature).hex()}}
        return base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()

    def fetch_with_payment(self, address: str, cancellation: threading.Event | None = None) -> PaymentResponse:
        url = self._url(address)
        deadline = _Deadline(self.timeout_ms, cancellation)

        def work() -> PaymentResponse:
            response = self._request(url, deadline)
            if response.status != 402:
                return response
            quote, amount = self._quote(response, url)
            if self.account is None:
                raise PaymentError("No paying wallet configured; unsigned quote and budget inspection remain available.")
            deadline.check()
            with self._lock:
                if self._spent + self._reserved + amount > self.total:
                    raise PaymentError("Insufficient remaining payment budget.")
                self._reserved += amount
            signed = False
            signing_started = False
            try:
                deadline.check()
                signing_started = True
                signature = self._sign(quote)
                signed = True
                # Timed-out/cancelled signing must never send a late retry.
                deadline.check()
                paid = self._request(url, deadline, signature)
                if paid.ok:
                    with self._lock:
                        self._reserved -= amount
                        self._spent += amount
                    amount = 0
                return paid
            finally:
                # A pending signature at cancellation/timeout remains ambiguous.
                if amount and not signed and not (signing_started and (deadline.stopped.is_set() or time.monotonic() >= deadline.end
                        or (cancellation is not None and cancellation.is_set()))):
                    with self._lock:
                        self._reserved -= amount

        return deadline.run(work)
