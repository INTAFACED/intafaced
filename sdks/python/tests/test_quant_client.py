"""Contract tests for the strategy API client against a local test double. No network."""

from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from intafaced_quant import QuantApiError, QuantClient, strategy_template

KEY = "ifk_test-quant-key"


class _Double(BaseHTTPRequestHandler):
    seen: list[dict] = []

    def log_message(self, *args) -> None:  # quiet
        return

    def _answer(self, status: int, body: object) -> None:
        raw = json.dumps(body).encode("utf-8") if not isinstance(body, bytes) else body
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _record(self) -> dict:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else ""
        row = {"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}
        _Double.seen.append(row)
        return row

    def do_GET(self) -> None:
        row = self._record()
        path = urlsplit(row["path"]).path
        if path == "/api/quant/trpc/studio.list":
            self._answer(200, {"result": {"data": {"items": [{"id": "s1", "name": "Mine"}]}}})
        elif path == "/api/quant/trpc/backtest.report":
            # A number with a fraction in the answer must reach the caller as a string, never a float.
            self._answer(200, b'{"result":{"data":{"metrics":{"pnl":"12.50","sharpe":1.25}}}}')
        elif path == "/api/v1/quant/live-runs":
            self._answer(200, {"runs": [{"runId": "r1", "cap": "100.00"}]})
        else:
            self._answer(404, {"error": {"message": "no such endpoint", "data": {"cause": {"code": "quant.key_no_such_endpoint"}}}})

    def do_POST(self) -> None:
        row = self._record()
        path = urlsplit(row["path"]).path
        if path == "/api/quant/trpc/backtest.start":
            if not row["headers"].get("idempotency-key"):
                self._answer(400, {"error": {"message": "Idempotency-Key", "data": {"cause": {"code": "quant.idempotency_key_required"}}}})
            else:
                self._answer(200, {"result": {"data": {"runId": "bt-1", "status": "done"}}})
        elif path.endswith("/stop"):
            self._answer(403, {"code": "InvalidOrder", "message": "Scope required", "intafacedCode": "scope.denied"})
        else:
            self._answer(200, {"state": "stopped", "stopSeq": 1})


class QuantClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Double)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        _Double.seen.clear()
        self.client = QuantClient(base_url=self.base, api_key=KEY)

    def test_blank_base_url_or_key_refuses(self) -> None:
        for base, key in (("", KEY), ("   ", KEY), (self.base, ""), (self.base, "  ")):
            with self.assertRaises(ValueError):
                QuantClient(base_url=base, api_key=key)

    def test_key_sent_as_bearer_and_get_input_is_trpc_json(self) -> None:
        listed = self.client.list_strategies(limit=20)
        self.assertEqual(listed, {"items": [{"id": "s1", "name": "Mine"}]})
        row = _Double.seen[-1]
        self.assertEqual(row["method"], "GET")
        self.assertEqual(row["headers"]["authorization"], f"Bearer {KEY}")
        self.assertNotIn("idempotency-key", row["headers"])
        query = parse_qs(urlsplit(row["path"]).query)
        self.assertEqual(json.loads(query["input"][0]), {"limit": 20})

    def test_start_backtest_requires_and_sends_idempotency_key(self) -> None:
        with self.assertRaises(TypeError):
            self.client.start_backtest({"strategyId": "s1"})  # type: ignore[call-arg]
        for bad in ("", "has space", "x" * 129):
            with self.assertRaises(ValueError):
                self.client.start_backtest({"strategyId": "s1"}, bad)
        self.assertEqual(_Double.seen, [])
        started = self.client.start_backtest({"strategyId": "s1", "version": 2, "cash": "10000"}, "backtest:s1:v2:2026-11")
        self.assertEqual(started, {"runId": "bt-1", "status": "done"})
        row = _Double.seen[-1]
        self.assertEqual(row["method"], "POST")
        self.assertEqual(row["headers"]["idempotency-key"], "backtest:s1:v2:2026-11")
        self.assertEqual(row["headers"]["content-type"], "application/json")
        self.assertEqual(json.loads(row["body"]), {"strategyId": "s1", "version": 2, "cash": "10000"})

    def test_typed_refusals_carry_the_service_code(self) -> None:
        with self.assertRaises(QuantApiError) as trpc:
            self.client.get_strategy("missing")
        self.assertEqual((trpc.exception.status, trpc.exception.code), (404, "quant.key_no_such_endpoint"))
        with self.assertRaises(QuantApiError) as rest:
            self.client.stop_live_run("r1", 1)
        self.assertEqual((rest.exception.status, rest.exception.code), (403, "scope.denied"))
        self.assertEqual(json.loads(_Double.seen[-1]["body"]), {"seq": 1})
        self.assertTrue(_Double.seen[-1]["path"].endswith("/api/v1/quant/live-runs/r1/stop"))

    def test_decimals_stay_strings(self) -> None:
        report = self.client.backtest_report("bt-1")
        self.assertEqual(report["metrics"], {"pnl": "12.50", "sharpe": "1.25"})
        self.assertEqual(self.client.list_live_runs()["runs"][0]["cap"], "100.00")
        with self.assertRaises(ValueError):
            self.client.start_backtest({"cash": 10000.0}, "backtest:float")
        self.assertEqual([r for r in _Double.seen if r["method"] == "POST"], [])

    def test_liquidate_posts_seq(self) -> None:
        self.assertEqual(self.client.liquidate_live_run("r 1", 3), {"state": "stopped", "stopSeq": 1})
        row = _Double.seen[-1]
        self.assertTrue(row["path"].endswith("/live-runs/r%201/liquidate"))
        self.assertEqual(json.loads(row["body"]), {"seq": 3})

    def test_template_uses_only_the_sandbox_host_objects(self) -> None:
        source = strategy_template()
        for host in ("oms.limitBuy(", "print("):
            self.assertIn(host, source)
        self.assertNotRegex(source, r"\b(import|def|for|while|class|open|exec|eval)\b")


if __name__ == "__main__":
    unittest.main()
