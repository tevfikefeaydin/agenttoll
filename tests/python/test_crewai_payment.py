"""Offline payment boundaries: actual helper/tool and real disposable signatures."""
import base64
import importlib
import json
import os
import sys
import threading
import time
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from eth_account import Account
from eth_account.messages import encode_typed_data
from pydantic import ValidationError

from examples.bounded_payment import (
    BoundedSafetyClient, HOSTED_RECIPIENT, HOSTED_URL, MAX_RESPONSE_BYTES,
    NETWORKS, PaymentError, PaymentTimeout,
)

TOKEN = "0x940181a94a35a4569e4529a3cdfb74e38fd98631"
URL = HOSTED_URL + "/api/base/safety/" + TOKEN


def quote(network_name="base", **changes):
    chain, _, asset, name = NETWORKS[network_name]
    accepted = {"scheme": "exact", "network": chain, "asset": asset, "amount": "3000",
                "payTo": HOSTED_RECIPIENT, "maxTimeoutSeconds": 60,
                "extra": {"name": name, "version": "2"}}
    accepted.update(changes)
    return {"x402Version": 2, "resource": {"url": URL}, "accepts": [accepted]}


def header(value):
    return base64.b64encode(json.dumps(value).encode()).decode()


class Raw:
    def __init__(self, chunks):
        self.chunks = iter(chunks)

    def read1(self, size, decode_content):
        assert size <= 65_536 and decode_content
        return next(self.chunks, b"")


class Response:
    def __init__(self, status, url=URL, headers=None, chunks=(b'{"verdict":"caution"}',)):
        self.status_code, self.url = status, url
        self.headers = headers or {}
        self.raw = Raw(chunks)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


class Session:
    def __init__(self, send):
        self.send = send

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def get(self, url, **kwargs):
        return self.send(url, **kwargs)


class PaymentTests(unittest.TestCase):
    def setUp(self):
        self.key = Account.create().key.hex()  # Unfunded, never printed or sent externally.
        self.signed = []
        self.requests = []
        self.request_lock = threading.Lock()

    def api(self, value=None, *, paid_status=200):
        value = quote() if value is None else value

        def send(url, **kwargs):
            with self.request_lock:
                self.requests.append((url, kwargs))
            self.assertFalse(kwargs["allow_redirects"])
            self.assertTrue(kwargs["stream"])
            self.assertTrue(all(0 < seconds <= 30 for seconds in kwargs["timeout"]))
            signature = kwargs["headers"].get("PAYMENT-SIGNATURE")
            if signature:
                with self.request_lock:
                    self.signed.append(json.loads(base64.b64decode(signature)))
                return Response(paid_status, url)
            return Response(402, url, {"PAYMENT-REQUIRED": header(value)})

        return patch("examples.bounded_payment.requests.Session", side_effect=lambda: Session(send))

    def assert_signature(self, payload, network):
        _, chain_id, asset, name = NETWORKS[network]
        auth = payload["payload"]["authorization"]
        self.assertEqual(auth["to"], HOSTED_RECIPIENT)
        self.assertEqual(auth["value"], "3000")
        self.assertEqual(auth["validAfter"], "0")
        self.assertTrue(0 < int(auth["validBefore"]) - int(time.time()) <= 60)
        typed = encode_typed_data(
            domain_data={"name": name, "version": "2", "chainId": chain_id, "verifyingContract": asset},
            message_types={"TransferWithAuthorization": [
                {"name": "from", "type": "address"}, {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"}, {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"}, {"name": "nonce", "type": "bytes32"},
            ]}, message_data=auth,
        )
        recovered = Account.recover_message(typed, signature=payload["payload"]["signature"])
        self.assertEqual(recovered, Account.from_key(self.key).address)

    def test_base_and_sepolia_sign_only_checked_eip3009_terms(self):
        for network in NETWORKS:
            with self.subTest(network=network):
                value = quote(network)
                value["extensions"] = {"malicious": {"sign": "more"}}
                value["accepts"][0]["extra"]["unrecognized"] = "ignored"
                with self.api(value):
                    client = BoundedSafetyClient(self.key, network=network)
                    response = client.fetch_with_payment(TOKEN)
                self.assertTrue(response.ok)
                self.assertEqual(response.text, '{"verdict":"caution"}')
                self.assert_signature(self.signed[-1], network)
                self.assertNotIn("extensions", self.signed[-1])
                self.assertEqual(set(self.signed[-1]["accepted"]["extra"]), {"name", "version"})
                self.assertEqual(client.get_payment_budget()["spentUsdc"], "0.003000")

    def test_forged_quote_terms_never_sign(self):
        bad = [
            {"amount": "50000"}, {"amount": "0"}, {"amount": "1e3"},
            {"payTo": "0x" + "1" * 40}, {"network": "eip155:1"},
            {"asset": NETWORKS["base-sepolia"][2]}, {"scheme": "other"},
            {"maxTimeoutSeconds": 86400}, {"maxTimeoutSeconds": 0}, {"maxTimeoutSeconds": True},
            {"extra": {"name": "USDC", "version": "2"}},
            {"extra": {"name": "USD Coin", "version": "1"}},
            {"extra": {"name": "USD Coin", "version": "2", "assetTransferMethod": "permit2"}},
            {"extra": {"name": "USD Coin", "version": "2", "paymentFlow": "approval"}},
        ]
        for changes in bad:
            with self.subTest(changes=changes), self.api(quote(**changes)):
                client = BoundedSafetyClient(self.key)
                with self.assertRaises(PaymentError):
                    client.fetch_with_payment(TOKEN)
                self.assertEqual(client.get_payment_budget()["remainingUsdc"], "1.000000")
        self.assertEqual(self.signed, [])

    def test_valid_address_casing_and_transfer_tags_are_preserved_for_server_matching(self):
        value = quote(payTo=HOSTED_RECIPIENT.upper().replace("0X", "0x"), asset=NETWORKS["base"][2].lower())
        value["accepts"][0]["extra"].update({"assetTransferMethod": "eip3009", "paymentFlow": "authorization"})
        with self.api(value):
            self.assertTrue(BoundedSafetyClient(self.key).fetch_with_payment(TOKEN).ok)
        self.assertEqual(self.signed[0]["accepted"], value["accepts"][0])
        self.assert_signature(self.signed[0], "base")

    def test_version_shape_and_full_resource_are_pinned(self):
        invalid = []
        for url in (URL + "?different=1", URL + "/", "https://attacker.example/billing", URL.replace(TOKEN, "0x" + "1" * 40)):
            value = quote()
            value["resource"]["url"] = url
            invalid.append(value)
        for replacement in ({"x402Version": 1}, {"x402Version": 2.0}, {"accepts": []}, {"accepts": [quote()["accepts"][0]] * 2}):
            invalid.append({**quote(), **replacement})
        for value in invalid:
            with self.api(value), self.assertRaises(PaymentError):
                BoundedSafetyClient(self.key).fetch_with_payment(TOKEN)
        self.assertEqual(self.signed, [])

    def test_redirects_and_changed_response_urls_never_sign(self):
        for status, url in ((302, URL), (307, URL), (402, "https://attacker.example/billing")):
            def send(*_, **kwargs):
                self.assertFalse(kwargs["allow_redirects"])
                return Response(status, url, {"Location": "https://attacker.example/billing", "PAYMENT-REQUIRED": header(quote())})
            with patch("examples.bounded_payment.requests.Session", side_effect=lambda: Session(send)):
                with self.assertRaises(PaymentError):
                    BoundedSafetyClient(self.key).fetch_with_payment(TOKEN)

    def test_quote_inspection_and_missing_wallet_do_not_spend(self):
        with self.api():
            client = BoundedSafetyClient()
            self.assertEqual(client.get_payment_quote(TOKEN)["amountUsdc"], "0.003000")
            with self.assertRaisesRegex(PaymentError, "wallet"):
                client.fetch_with_payment(TOKEN)
        self.assertEqual(self.signed, [])
        self.assertEqual(client.get_payment_budget()["remainingUsdc"], "1.000000")

    def test_invalid_config_and_addresses_fail_before_http(self):
        cases = [
            {"base_url": "https://custom.example"}, {"base_url": HOSTED_URL + "/path"},
            {"base_url": "http://remote.example", "recipient": HOSTED_RECIPIENT},
            {"base_url": "https://name:secret@agenttoll.app"}, {"base_url": HOSTED_URL + "?"},
            {"recipient": "0x" + "0" * 40}, {"network": "ethereum"}, {"total_budget_usdc": "-1"},
            {"total_budget_usdc": "0.0000001"}, {"total_budget_usdc": "NaN"},
            {"timeout_ms": 0}, {"timeout_ms": 1.5}, {"timeout_ms": True},
        ]
        with patch("examples.bounded_payment.requests.Session") as http:
            for config in cases:
                with self.subTest(config=config), self.assertRaises(PaymentError):
                    BoundedSafetyClient(self.key, **config)
            client = BoundedSafetyClient(self.key)
            for address in ("../scout", TOKEN + "?x=1", "0x" + "0" * 40, "not-an-address"):
                with self.assertRaises(PaymentError):
                    client.fetch_with_payment(address)
            http.assert_not_called()

    def test_per_call_limit_cannot_raise_price_and_can_lower_it(self):
        with self.api(quote(amount="4000")), self.assertRaisesRegex(PaymentError, "ceiling"):
            BoundedSafetyClient(self.key, max_per_call_usdc="100").fetch_with_payment(TOKEN)
        with self.api(), self.assertRaisesRegex(PaymentError, "ceiling"):
            BoundedSafetyClient(self.key, max_per_call_usdc="0.002").fetch_with_payment(TOKEN)
        self.assertEqual(self.signed, [])

    def test_parallel_calls_cannot_oversubscribe(self):
        with self.api(), ThreadPoolExecutor(max_workers=2) as pool:
            client = BoundedSafetyClient(self.key, total_budget_usdc="0.003")
            calls = [pool.submit(client.fetch_with_payment, TOKEN) for _ in range(2)]
            successes = failures = 0
            for call in calls:
                try:
                    self.assertTrue(call.result().ok)
                    successes += 1
                except PaymentError as error:
                    self.assertIn("budget", str(error))
                    failures += 1
        self.assertEqual((successes, failures, len(self.signed)), (1, 1, 1))
        self.assertEqual(client.get_payment_budget()["remainingUsdc"], "0.000000")

    def test_budget_persists_across_calls_and_signed_errors_stay_reserved(self):
        with self.api(paid_status=500):
            client = BoundedSafetyClient(self.key, total_budget_usdc="0.003")
            self.assertEqual(client.fetch_with_payment(TOKEN).status, 500)
            self.assertEqual(client.get_payment_budget()["reservedUsdc"], "0.003000")
            with self.assertRaisesRegex(PaymentError, "budget"):
                client.fetch_with_payment(TOKEN)
        self.assertEqual(len(self.signed), 1)

    def test_rejected_signing_releases_budget(self):
        with self.api():
            client = BoundedSafetyClient(self.key, total_budget_usdc="0.003")
            with patch.object(client, "_sign", side_effect=PaymentError("wallet rejected")):
                with self.assertRaisesRegex(PaymentError, "rejected"):
                    client.fetch_with_payment(TOKEN)
            self.assertEqual(client.get_payment_budget()["remainingUsdc"], "0.003000")
            self.assertTrue(client.fetch_with_payment(TOKEN).ok)

    def test_pending_signature_timeout_keeps_reservation_and_cannot_retry_late(self):
        release, started, done = threading.Event(), threading.Event(), threading.Event()
        client = BoundedSafetyClient(self.key, timeout_ms=1000, total_budget_usdc="0.003")
        sign = client._sign

        def pending(value):
            started.set()
            release.wait(3)
            try:
                return sign(value)
            finally:
                done.set()

        with self.api(), patch.object(client, "_sign", side_effect=pending):
            with self.assertRaises(PaymentTimeout):
                client.fetch_with_payment(TOKEN)
            self.assertTrue(started.is_set())
            self.assertEqual(client.get_payment_budget()["reservedUsdc"], "0.003000")
            release.set()
            self.assertTrue(done.wait(1))
            self.assertEqual(self.signed, [])

    def test_pre_cancelled_call_never_fetches(self):
        cancellation = threading.Event()
        cancellation.set()
        with self.api(), self.assertRaisesRegex(PaymentError, "cancelled"):
            BoundedSafetyClient(self.key).fetch_with_payment(TOKEN, cancellation)
        self.assertEqual(self.requests, [])

    def test_cancellation_while_signing_keeps_budget_and_never_retries(self):
        release, started, finished, cancellation = (threading.Event() for _ in range(4))
        client = BoundedSafetyClient(self.key, total_budget_usdc="0.003")
        sign = client._sign
        def pending(value):
            started.set()
            release.wait(2)
            try:
                return sign(value)
            finally:
                finished.set()
        with self.api(), patch.object(client, "_sign", side_effect=pending), ThreadPoolExecutor(max_workers=1) as pool:
            call = pool.submit(client.fetch_with_payment, TOKEN, cancellation)
            self.assertTrue(started.wait(1))
            cancellation.set()
            with self.assertRaisesRegex(PaymentError, "cancelled"):
                call.result(timeout=1)
            self.assertEqual(client.get_payment_budget()["reservedUsdc"], "0.003000")
            release.set()
            self.assertTrue(finished.wait(1))
            self.assertEqual(self.signed, [])

    def test_cancellation_during_signed_http_retains_ambiguous_amount(self):
        release, started, cancellation = (threading.Event() for _ in range(3))
        def send(url, **kwargs):
            if not kwargs["headers"]:
                return Response(402, url, {"PAYMENT-REQUIRED": header(quote())})
            started.set()
            release.wait(2)
            return Response(200, url)
        client = BoundedSafetyClient(self.key)
        with patch("examples.bounded_payment.requests.Session", side_effect=lambda: Session(send)), ThreadPoolExecutor(max_workers=1) as pool:
            call = pool.submit(client.fetch_with_payment, TOKEN, cancellation)
            self.assertTrue(started.wait(1))
            cancellation.set()
            with self.assertRaisesRegex(PaymentError, "cancelled"):
                call.result(timeout=1)
            self.assertEqual(client.get_payment_budget()["reservedUsdc"], "0.003000")
            self.assertEqual(client.get_payment_budget()["spentUsdc"], "0.000000")
            release.set()

    def test_cancellation_while_quote_pending_cannot_sign_late(self):
        started, release, cancelled = threading.Event(), threading.Event(), threading.Event()
        def send(url, **kwargs):
            self.assertFalse(kwargs["headers"])
            started.set()
            release.wait(2)
            return Response(402, url, {"PAYMENT-REQUIRED": header(quote())})
        client = BoundedSafetyClient(self.key)
        with patch("examples.bounded_payment.requests.Session", side_effect=lambda: Session(send)), ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(client.fetch_with_payment, TOKEN, cancelled)
            self.assertTrue(started.wait(1))
            cancelled.set()
            with self.assertRaisesRegex(PaymentError, "cancelled"):
                pending.result(timeout=1)
            release.set()
        self.assertEqual(client.get_payment_budget()["remainingUsdc"], "1.000000")

    def test_paid_body_timeout_keeps_signed_reservation(self):
        release, reading = threading.Event(), threading.Event()
        def send(url, **kwargs):
            if not kwargs["headers"]:
                return Response(402, url, {"PAYMENT-REQUIRED": header(quote())})
            response = Response(200, url)
            def unfinished(*_, **__):
                reading.set()
                release.wait(5)
                return b""
            response.raw.read1 = unfinished
            return response
        client = BoundedSafetyClient(self.key, timeout_ms=2000)
        with patch("examples.bounded_payment.requests.Session", side_effect=lambda: Session(send)), ThreadPoolExecutor(max_workers=1) as pool:
            call = pool.submit(client.fetch_with_payment, TOKEN)
            try:
                self.assertTrue(reading.wait(1.8), "Signed response body must start before testing its deadline")
                with self.assertRaises(PaymentTimeout):
                    call.result(timeout=3)
                self.assertEqual(client.get_payment_budget()["reservedUsdc"], "0.003000")
            finally:
                release.set()

    def test_response_size_bound(self):
        def send(url, **_):
            return Response(200, url, chunks=(b"x" * 65_536 for _ in range(MAX_RESPONSE_BYTES // 65_536 + 1)))
        with patch("examples.bounded_payment.requests.Session", side_effect=lambda: Session(send)):
            with self.assertRaisesRegex(PaymentError, "Oversized"):
                BoundedSafetyClient(self.key).fetch_with_payment(TOKEN)

    def test_missing_malformed_and_oversized_quote_headers_never_sign(self):
        for encoded in (None, "invalid!", "x" * 32_769):
            def send(url, **_):
                return Response(402, url, {"PAYMENT-REQUIRED": encoded} if encoded else {})
            with patch("examples.bounded_payment.requests.Session", side_effect=lambda: Session(send)):
                with self.assertRaisesRegex(PaymentError, "quote"):
                    BoundedSafetyClient(self.key).fetch_with_payment(TOKEN)

    def test_real_http_server_without_headers_returns_at_deadline(self):
        release, received = threading.Event(), threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                received.set()
                release.wait(2)
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = BoundedSafetyClient(self.key, base_url=f"http://127.0.0.1:{server.server_port}",
                                         recipient=HOSTED_RECIPIENT, timeout_ms=500)
            started = time.monotonic()
            with self.assertRaises(PaymentTimeout):
                client.fetch_with_payment(TOKEN)
            self.assertTrue(received.is_set())
            self.assertLess(time.monotonic() - started, 1.8)
            self.assertEqual(client.get_payment_budget()["reservedUsdc"], "0.000000")
        finally:
            release.set()
            server.shutdown()
            server.server_close()

    def test_actual_crewai_callbacks_share_one_budget_and_validate_schema(self):
        host, tools = types.ModuleType("crewai"), types.ModuleType("crewai.tools")
        tools.BaseTool = object
        with patch.dict(sys.modules, {"crewai": host, "crewai.tools": tools}), patch.dict(os.environ, {
                "EVM_PRIVATE_KEY": self.key, "AGENTTOLL_BUDGET_USDC": "0.003"}, clear=True), patch("dotenv.load_dotenv"):
            module = importlib.import_module("examples.crewai_tool")
            module = importlib.reload(module)
            with self.api():
                self.assertIn("caution", module.CheckTokenSafety()._run(TOKEN))
                with self.assertRaisesRegex(PaymentError, "budget"):
                    module.CheckTokenSafety()._run(TOKEN)
            with self.assertRaises(ValidationError):
                module.CheckTokenSafetyInput(address="../scout")
        self.assertEqual(len(self.signed), 1)

    def test_real_http_trickle_body_cannot_extend_total_deadline(self):
        release = threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                try:
                    while not release.is_set():
                        self.wfile.write(b"slow")
                        self.wfile.flush()
                        release.wait(0.02)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            client = BoundedSafetyClient(self.key, base_url=f"http://127.0.0.1:{server.server_port}",
                                         recipient=HOSTED_RECIPIENT, timeout_ms=500)
            started = time.monotonic()
            with self.assertRaises(PaymentTimeout):
                client.fetch_with_payment(TOKEN)
            self.assertLess(time.monotonic() - started, 1.8)
        finally:
            release.set()
            server.shutdown()
            server.server_close()

    def test_local_and_remote_env_trust_boundaries(self):
        with patch.dict(os.environ, {"AGENTTOLL_URL": "http://localhost:4021", "ADDRESS": HOSTED_RECIPIENT}, clear=True):
            local = BoundedSafetyClient.from_env()
            self.assertEqual(local.network, "eip155:84532")
        with patch.dict(os.environ, {"AGENTTOLL_URL": "https://custom.example", "ADDRESS": HOSTED_RECIPIENT}, clear=True):
            with self.assertRaisesRegex(PaymentError, "recipient"):
                BoundedSafetyClient.from_env()


if __name__ == "__main__":
    unittest.main()
