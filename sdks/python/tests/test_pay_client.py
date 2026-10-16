"""Contract tests for the merchant Payments client. Not a live acquirer."""

from __future__ import annotations

import hashlib
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from intafaced_pay import create_pay_client, sign_pay_request, signatures_equal
from intafaced_pay.client import PayClient, retry_delay_seconds
from intafaced_pay.sign import canonical_request, sign_request

SECRET = "ifs_vector-lock"
GOLDEN = "d61e9fa131b74a34ffdf69dbeee3fe8b82b68168d54a230d9d7ed12f042b4283"


class SigningHelperTest(unittest.TestCase):
    def test_published_vector(self) -> None:
        canonical = canonical_request(
            method="post",
            path="/api/pay/v1/payments?merchantId=abc",
            timestamp="1700000000",
            nonce="nonce-fresh-1",
            body_hash="ab" * 32,
        )
        self.assertEqual(sign_request(SECRET, canonical), GOLDEN)
        signed = sign_pay_request(
            secret=SECRET,
            method="POST",
            path="/api/pay/v1/payments",
            timestamp="1700000000",
            nonce="nonce-fresh-1",
            body=b'{"amount":"1.10"}',
        )
        self.assertEqual(signed["body_hash"], hashlib.sha256(b'{"amount":"1.10"}').hexdigest())
        self.assertEqual(
            signed["signature"],
            sign_request(
                SECRET,
                canonical_request(
                    method="POST",
                    path="/api/pay/v1/payments",
                    timestamp="1700000000",
                    nonce="nonce-fresh-1",
                    body_hash=signed["body_hash"],
                ),
            ),
        )

    def test_constant_time_length_mismatch(self) -> None:
        source = Path(__file__).resolve().parents[1].joinpath("intafaced_pay", "sign.py").read_text()
        self.assertIn("compare_digest", source)
        self.assertNotRegex(source, r"signature\s*==")
        self.assertTrue(signatures_equal("abcd", "abcd"))
        self.assertFalse(signatures_equal("abcd", "ab"))
        self.assertFalse(signatures_equal("zz", "zz"))


class PayClientTest(unittest.TestCase):
    def test_refuses_blank_config_and_numeric_amount(self) -> None:
        with self.assertRaises(ValueError):
            PayClient(base_url="  ", api_key="ifc_test_x")
        with self.assertRaises(ValueError):
            PayClient(base_url="https://pay.example/api/pay/v1", api_key="")
        seen: list[object] = []

        def transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, str]:
            seen.append(body)
            return 200, "{}"

        client = PayClient(base_url="https://pay.example/api/pay/v1", api_key="ifc_test_x", transport=transport, max_retries=0)
        with self.assertRaisesRegex(ValueError, "decimal string"):
            client.call("POST", "/payments", body={"amount": 1.1}, idempotency=True)
        self.assertEqual(seen, [])

    def test_amount_stays_a_string(self) -> None:
        captured: dict[str, bytes | None] = {}

        def transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, str]:
            captured["body"] = body
            return 200, "{}"

        client = PayClient(base_url="https://pay.example/api/pay/v1", api_key="ifc_test_x", transport=transport, max_retries=0)
        client.call("POST", "/payments", body={"amount": "1.10"}, idempotency=True, idempotency_key="business-1")
        self.assertEqual(captured["body"], b'{"amount":"1.10"}')

    def test_retry_reuses_key_and_refreshes_nonce(self) -> None:
        nonces = iter(["nonce-fresh-1", "nonce-fresh-2"])
        calls: list[dict[str, object]] = []

        def transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, str]:
            calls.append({"headers": dict(headers), "url": url, "body": body or b""})
            return (500, "{}") if len(calls) == 1 else (200, '{"amount":"1.10"}')

        client = PayClient(
            base_url="https://pay.example/api/pay/v1",
            api_key="ifc_test_x",
            signing_secret=SECRET,
            max_retries=1,
            now=lambda: 1_700_000_000_000,
            nonce=lambda: next(nonces),
            transport=transport,
            sleep=lambda _seconds: None,
        )
        result = client.call(
            "POST",
            "/payments",
            body={"amount": "1.10"},
            query={"merchantId": "abc"},
            idempotency=True,
            idempotency_key="business-1",
        )
        self.assertEqual(result["status"], 200)
        self.assertEqual(len(calls), 2)
        first = calls[0]["headers"]
        second = calls[1]["headers"]
        assert isinstance(first, dict) and isinstance(second, dict)
        self.assertEqual(first["idempotency-key"], "business-1")
        self.assertEqual(second["idempotency-key"], "business-1")
        self.assertEqual(first["x-intafaced-request-nonce"], "nonce-fresh-1")
        self.assertEqual(second["x-intafaced-request-nonce"], "nonce-fresh-2")
        for call in calls:
            headers = call["headers"]
            raw = call["body"]
            url = call["url"]
            assert isinstance(headers, dict) and isinstance(raw, bytes) and isinstance(url, str)
            parts = urlsplit(url)
            signed_path = parts.path + (f"?{parts.query}" if parts.query else "")
            signed = sign_pay_request(
                secret=SECRET,
                method="POST",
                path=signed_path,
                timestamp=str(headers["x-intafaced-request-timestamp"]),
                nonce=str(headers["x-intafaced-request-nonce"]),
                body=raw,
            )
            self.assertEqual(headers["x-intafaced-request-signature"], signed["signature"])
            self.assertEqual(signed_path, "/api/pay/v1/payments?merchantId=abc")

    def test_client_error_is_not_retried_and_unsigned_without_a_secret(self) -> None:
        calls: list[dict[str, str]] = []

        def transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, str]:
            calls.append(dict(headers))
            return 400, '{"code":"pay.bad_request"}'

        client = PayClient(base_url="https://pay.example/api/pay/v1", api_key="ifc_test_x", max_retries=2, transport=transport)
        result = client.call("POST", "/payments", body={"amount": "1.00"}, idempotency=True)
        self.assertEqual(result["status"], 400)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("x-intafaced-request-signature", calls[0])
        self.assertTrue(calls[0]["idempotency-key"])

    def test_sandbox_retry(self) -> None:
        seen: list[dict[str, str]] = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("content-length", "0"))
                body = self.rfile.read(length)
                seen.append(
                    {
                        "path": self.path,
                        "body": body.decode("utf-8"),
                        "idempotency": self.headers.get("idempotency-key", ""),
                        "nonce": self.headers.get("x-intafaced-request-nonce", ""),
                        "signature": self.headers.get("x-intafaced-request-signature", ""),
                        "timestamp": self.headers.get("x-intafaced-request-timestamp", ""),
                    }
                )
                payload = b'{"id":"pay_sandbox","amount":"1.10"}'
                self.send_response(500 if len(seen) == 1 else 200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, fmt: str, *args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            client, api = create_pay_client(
                base_url=f"http://127.0.0.1:{port}/api/pay/v1",
                api_key="ifc_test_sandbox",
                signing_secret=SECRET,
                max_retries=1,
                sleep=lambda _seconds: None,
            )
            del client
            result = api.post_payments(body={"amount": "1.10", "assetId": "USD"})
            self.assertEqual(result["status"], 200)
            self.assertEqual(result["body"]["amount"], "1.10")
            self.assertEqual(len(seen), 2)
            self.assertEqual(seen[0]["idempotency"], seen[1]["idempotency"])
            self.assertNotEqual(seen[0]["nonce"], seen[1]["nonce"])
            self.assertEqual(seen[0]["path"], "/api/pay/v1/payments")
            for call in seen:
                signed = sign_pay_request(
                    secret=SECRET,
                    method="POST",
                    path=call["path"],
                    timestamp=call["timestamp"],
                    nonce=call["nonce"],
                    body=call["body"].encode("utf-8"),
                )
                self.assertEqual(call["signature"], signed["signature"])
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

    def test_retry_is_limited_to_safe_methods_or_an_idempotency_key(self) -> None:
        posts = {"n": 0}

        def post_transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, str]:
            posts["n"] += 1
            return 500, "{}"

        unsafe = PayClient(
            base_url="https://pay.example/api/pay/v1",
            api_key="ifc_test_x",
            max_retries=2,
            transport=post_transport,
            sleep=lambda _seconds: (_ for _ in ()).throw(AssertionError("unsafe POST must not wait")),
        )
        result = unsafe.call("POST", "/payments", body={}, idempotency=False)
        self.assertEqual(result["status"], 500)
        self.assertEqual(posts["n"], 1)

        delays: list[float] = []
        gets = {"n": 0}

        def get_transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, str, str | None]:
            gets["n"] += 1
            if gets["n"] == 1:
                return 503, "{}", "2"
            return 200, "{}", None

        reader = PayClient(
            base_url="https://pay.example/api/pay/v1",
            api_key="ifc_test_x",
            max_retries=1,
            transport=get_transport,
            now=lambda: 1_700_000_000_000,
            random_fn=lambda: 0.0,
            sleep=delays.append,
        )
        got = reader.call("GET", "/payments")
        self.assertEqual(got["status"], 200)
        self.assertEqual(gets["n"], 2)
        self.assertEqual(delays, [2.0])

        heads = {"n": 0}
        head_delays: list[float] = []

        def head_transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, str]:
            heads["n"] += 1
            return (429, "") if heads["n"] == 1 else (200, "")

        head = PayClient(
            base_url="https://pay.example/api/pay/v1",
            api_key="ifc_test_x",
            max_retries=1,
            transport=head_transport,
            now=lambda: 1_700_000_000_000,
            random_fn=lambda: 0.0,
            sleep=head_delays.append,
        )
        head.call("HEAD", "/payments")
        self.assertEqual(heads["n"], 2)
        self.assertEqual(head_delays, [retry_delay_seconds(0, None, 1_700_000_000, lambda: 0.0)])

        keyed_posts = {"n": 0}

        def keyed_transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, str]:
            keyed_posts["n"] += 1
            return (500, "{}") if keyed_posts["n"] == 1 else (200, "{}")

        keyed = PayClient(
            base_url="https://pay.example/api/pay/v1",
            api_key="ifc_test_x",
            max_retries=1,
            transport=keyed_transport,
            sleep=lambda _seconds: None,
        )
        posted = keyed.call("POST", "/payments", body={}, idempotency_key="business-1")
        self.assertEqual(posted["status"], 200)
        self.assertEqual(keyed_posts["n"], 2)

    def test_generated_surface_has_no_founder_or_operator_paths(self) -> None:
        root = Path(__file__).resolve().parents[1]
        for relative in ("intafaced_pay/operations.py", "openapi/payments.openapi.json"):
            text = (root / relative).read_text()
            self.assertNotIn("founderAdmin", text)
            self.assertNotIn("payHalts", text)
            self.assertNotIn("operatorStatus", text)
            self.assertNotIn("/operator/", text)
            self.assertNotIn("/operator\"", text)


if __name__ == "__main__":
    unittest.main()
