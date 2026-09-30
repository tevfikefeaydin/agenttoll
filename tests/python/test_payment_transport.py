"""Loopback transport regressions; payment headers are invalid test markers."""
import base64
import json
import socket
import ssl
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests
import urllib3.connection as connections
from requests.adapters import HTTPAdapter
from urllib3.connectionpool import HTTPConnectionPool
from urllib3.poolmanager import pool_classes_by_scheme

from examples.bounded_payment import (
    BoundedSafetyClient, HOSTED_RECIPIENT, NETWORKS, PaymentError,
    _Deadline, _DeadlineAdapter,
)

TOKEN = "0x" + "1" * 40
MARKER = "offline-invalid-payment-marker"

# Public, disposable TLS fixture for localhost/127.0.0.1, valid until 2126.
# This key is solely for the loopback TLS server, never an EVM account.
TLS_KEY = """-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg4/AqcCQJnuDvm4Hh
tVVoPmxfdTC0k7BH0p/K/My5x4ehRANCAAQUZZQVX2Du/rNK0l2u8MbCsKl5modH
kjfAcdwaROD5G5CU4kkjKp24RBNpcCc/A9jLfR41/vgA+nA3O+lBp2HB
-----END PRIVATE KEY-----
"""
TLS_CERT = """-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUIXVfqXyolVDz2OGKb3gWoeHtmjgwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkzMDIxNDgxNVoYDzIxMjYwOTA2
MjE0ODE1WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQUZZQVX2Du/rNK0l2u8MbCsKl5modHkjfAcdwaROD5G5CU4kkjKp24
RBNpcCc/A9jLfR41/vgA+nA3O+lBp2HBo28wbTAdBgNVHQ4EFgQUeRNWzHrh0Bsm
j8I4WOv3ZfBXkMIwHwYDVR0jBBgwFoAUeRNWzHrh0Bsmj8I4WOv3ZfBXkMIwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2NhbGhvc3QwCgYIKoZI
zj0EAwIDSAAwRQIgXPYJhdywtKkFwbiWCJ+995k+Thq9zxlgY3cwXYzLTFMCIQDi
ZYbZAZ4xdXqTtNQhOPNOvcMWLwzi7PH15WVmh7ciQQ==
-----END CERTIFICATE-----
"""


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture = tempfile.TemporaryDirectory(prefix="agenttoll-transport-")
        cls.addClassCleanup(fixture.cleanup)
        cls.cert = Path(fixture.name) / "localhost.pem"
        key = Path(fixture.name) / "localhost.key"
        cls.cert.write_text(TLS_CERT, encoding="ascii")
        key.write_text(TLS_KEY, encoding="ascii")
        cls.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cls.tls.load_cert_chain(cls.cert, key)

    @contextmanager
    def peer(self, transport):
        tls = self.tls
        received, tunnels = [], []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def handle(self):
                try:
                    super().handle()
                except (ConnectionResetError, ConnectionAbortedError):
                    pass  # Expected when the client closes a cancelled socket.

            def do_GET(self):
                marker = self.headers.get("PAYMENT-SIGNATURE")
                received.append(marker)
                if marker:
                    self.send_response(200)
                else:
                    resource = self.path if transport == "http-proxy" else origin + self.path
                    value = {"x402Version": 2, "resource": {"url": resource}, "accepts": [{
                        "scheme": "exact", "network": NETWORKS["base"][0],
                        "asset": NETWORKS["base"][2], "amount": "3000",
                        "payTo": HOSTED_RECIPIENT, "maxTimeoutSeconds": 60,
                        "extra": {"name": NETWORKS["base"][3], "version": "2"},
                    }]}
                    self.send_response(402)
                    self.send_header("PAYMENT-REQUIRED", base64.b64encode(json.dumps(value).encode()).decode())
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_CONNECT(self):
                tunnels.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.flush()
                # Terminate the test tunnel locally as the TLS origin; never
                # resolve or connect to the CONNECT target.
                try:
                    with tls.wrap_socket(self.connection, server_side=True) as stream:
                        Handler(stream, self.client_address, self.server)
                except (ssl.SSLError, ConnectionResetError, ConnectionAbortedError):
                    pass  # Cancellation can close an unfinished handshake.
                self.close_connection = True

        class Server(ThreadingHTTPServer):
            def get_request(self):
                stream, address = super().get_request()
                stream.settimeout(5)
                if transport == "https":
                    try:
                        stream = tls.wrap_socket(stream, server_side=True)
                    except BaseException:
                        stream.close()
                        raise
                return stream, address

        server = Server(("127.0.0.1", 0), Handler)
        proxy = f"http://127.0.0.1:{server.server_port}"
        origin = {
            "https": f"https://127.0.0.1:{server.server_port}",
            "http-proxy": "http://localhost:9",
            "connect-proxy": "https://localhost:9",
        }[transport]
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        try:
            yield origin, proxy, received, tunnels
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def run_transport(self, transport, stage=None, mode=None):
        entered, release, finished, signing, cancelled = (threading.Event() for _ in range(5))
        original_session, original_dns = requests.Session, socket.getaddrinfo
        original_tls = connections._ssl_wrap_socket_and_match_hostname
        original_tunnel = connections.HTTPSConnection._tunnel
        with self.peer(transport) as (origin, proxy, received, tunnels):
            client = BoundedSafetyClient(base_url=origin, recipient=HOSTED_RECIPIENT,
                                         timeout_ms=1500 if mode == "timeout" else 5000)
            client.account = object()  # Only bypass the wallet-present check.
            original_request = client._request

            def pause():
                entered.set()
                if not release.wait(5):
                    raise AssertionError("Test did not release the blocked connection")

            def dns(host, *args, **kwargs):
                self.assertEqual(host, "127.0.0.1", "Transport must remain on loopback")
                if signing.is_set() and stage == "dns":
                    pause()
                return original_dns(host, *args, **kwargs)

            def wrap_tls(*args, **kwargs):
                result = original_tls(*args, **kwargs)
                if signing.is_set() and stage == "tls":
                    pause()  # Real, verified TLS completed; no HTTP headers yet.
                return result

            def tunnel(connection):
                result = original_tunnel(connection)
                if signing.is_set() and stage == "tunnel":
                    pause()
                return result

            def session():
                value = original_session()
                value.trust_env = False
                value.verify = str(self.cert)
                if transport != "https":
                    value.proxies = {"http": proxy, "https": proxy}
                return value

            def sign(_):
                signing.set()
                return MARKER

            def request(url, deadline, signature=None):
                try:
                    return original_request(url, deadline, signature)
                finally:
                    if signature:
                        finished.set()

            with patch.object(client, "_sign", side_effect=sign), \
                    patch.object(client, "_request", side_effect=request), \
                    patch.object(requests, "Session", side_effect=session), \
                    patch.object(socket, "getaddrinfo", side_effect=dns), \
                    patch.object(connections, "_ssl_wrap_socket_and_match_hostname", side_effect=wrap_tls), \
                    patch.object(connections.HTTPSConnection, "_tunnel", tunnel), \
                    ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(client.fetch_with_payment, TOKEN, cancelled)
                try:
                    if stage is None:
                        self.assertTrue(pending.result(timeout=3).ok)
                        self.assertEqual(received, [None, MARKER])
                        self.assertEqual(client.get_payment_budget()["spentUsdc"], "0.003000")
                    else:
                        self.assertTrue(entered.wait(2), "Signed retry must reach the blocked stage")
                        if mode == "cancel":
                            cancelled.set()
                        with self.assertRaisesRegex(PaymentError, "cancelled" if mode == "cancel" else "timed out"):
                            pending.result(timeout=3)
                        self.assertEqual(received, [None])
                finally:
                    release.set()
                    self.assertTrue(finished.wait(3), "HTTP worker must finish before patches are removed")
                if stage is not None:
                    self.assertEqual(received, [None], "Late connection sent a payment header")
                    self.assertEqual(client.get_payment_budget()["reservedUsdc"], "0.003000")
                if transport == "connect-proxy":
                    self.assertEqual(tunnels, ["localhost:9", "localhost:9"])

    def test_verified_tls_and_proxy_success_paths(self):
        for transport in ("https", "http-proxy", "connect-proxy"):
            with self.subTest(transport=transport):
                self.run_transport(transport)

    def test_late_tls_completion_cannot_send_payment(self):
        for transport in ("https", "connect-proxy"):
            for mode in ("cancel", "timeout"):
                with self.subTest(transport=transport, mode=mode):
                    self.run_transport(transport, "tls", mode)

    def test_late_proxy_dns_cannot_send_payment(self):
        for mode in ("cancel", "timeout"):
            with self.subTest(mode=mode):
                self.run_transport("http-proxy", "dns", mode)

    def test_late_connect_tunnel_cannot_send_payment(self):
        for mode in ("cancel", "timeout"):
            with self.subTest(mode=mode):
                self.run_transport("connect-proxy", "tunnel", mode)

    def test_manager_classes_are_isolated_and_cached_proxy_is_not_rewrapped(self):
        original = pool_classes_by_scheme.copy()
        first = _DeadlineAdapter(_Deadline(5000, None))
        second = _DeadlineAdapter(_Deadline(5000, None))
        ordinary = HTTPAdapter()
        for adapter in (first, second, ordinary):
            self.addCleanup(adapter.close)
        proxy = first.proxy_manager_for("http://127.0.0.1:9")
        proxy_classes = proxy.pool_classes_by_scheme.copy()
        self.assertIs(first.proxy_manager_for("http://127.0.0.1:9"), proxy)
        self.assertEqual(proxy.pool_classes_by_scheme, proxy_classes)
        self.assertEqual(pool_classes_by_scheme, original)
        self.assertEqual(ordinary.poolmanager.pool_classes_by_scheme, original)
        for scheme in ("http", "https"):
            classes = [manager.pool_classes_by_scheme[scheme] for manager in (
                first.poolmanager, second.poolmanager, proxy,
            )]
            self.assertEqual(len(set(classes)), 3)
            for pool in classes:
                self.assertTrue(issubclass(pool.ConnectionCls, original[scheme].ConnectionCls))

    def test_cancelled_adapter_cannot_write_reused_socket_or_cancel_other_adapter(self):
        cancelled = threading.Event()
        first = _DeadlineAdapter(_Deadline(5000, cancelled))
        second = _DeadlineAdapter(_Deadline(5000, None))
        self.addCleanup(first.close)
        self.addCleanup(second.close)
        cancelled.set()
        for scheme in ("http", "https"):
            with self.subTest(scheme=scheme):
                for adapter in (first, second):
                    connection = adapter.poolmanager.pool_classes_by_scheme[scheme].ConnectionCls("127.0.0.1")
                    connection.sock = Mock()
                    if adapter is first:
                        with self.assertRaisesRegex(PaymentError, "cancelled"):
                            connection.send(b"PAYMENT-SIGNATURE: " + MARKER.encode())
                        connection.sock.sendall.assert_not_called()
                    else:
                        connection.send(b"independent request")
                        connection.sock.sendall.assert_called_once_with(b"independent request")
                    connection.close()

    def test_guard_preserves_specialized_connection_constructor(self):
        # SOCKS-style managers supply connection-specific constructor arguments.
        class SpecializedConnection(connections.HTTPConnection):
            def __init__(self, *args, _socks_options, **kwargs):
                self.options = _socks_options
                super().__init__(*args, **kwargs)

        class SpecializedPool(HTTPConnectionPool):
            ConnectionCls = SpecializedConnection

        adapter = _DeadlineAdapter(_Deadline(5000, None))
        self.addCleanup(adapter.close)
        original = {"http": SpecializedPool}
        manager = SimpleNamespace(pool_classes_by_scheme=original)
        adapter._guard(manager)
        pool = manager.pool_classes_by_scheme["http"]("127.0.0.1", _socks_options={"rdns": True})
        self.addCleanup(pool.close)
        connection = pool._new_conn()
        self.assertIsInstance(connection, SpecializedConnection)
        self.assertEqual(connection.options, {"rdns": True})
        self.assertEqual(original, {"http": SpecializedPool})
        connection.close()


if __name__ == "__main__":
    unittest.main()
