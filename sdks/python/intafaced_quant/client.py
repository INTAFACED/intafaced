"""Strategy API client (J-algo-dev-14, J-algo-dev-16).

An API key reaches svc-quant's strategy procedures over tRPC (a query as `?input=<JSON>`, a mutation as a JSON body)
and svc-trade's live-run routes. The key goes as `Authorization: Bearer <key>`. A backtest start sends the caller's own
`Idempotency-Key`, a business key; this client never makes one up. A refusal raises `QuantApiError` with the service's
`intafacedCode`. Values stay as the API sent them: decimals are strings, and a float in a request is refused. A blank
base URL or API key refuses. There is no default host. `strategy_template()` is the sandbox's Python starter.

This module is the whole client: it runs as the package `intafaced_quant` or saved alone as `intafaced_quant.py`.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

Transport = Callable[[str, str, dict[str, str], bytes | None], tuple[int, str]]

_QUANT = "api/quant/trpc/"
_LIVE = "api/v1/quant/live-runs"


class QuantApiError(Exception):
    """A refusal from the strategy API. `code` is the service's `intafacedCode` (None when it sent none)."""

    def __init__(self, status: int, code: str | None, message: str, body: Any) -> None:
        super().__init__(f"{status} {code or 'unknown'}: {message}")
        self.status = status
        self.code = code
        self.body = body


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


def _urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, str]:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=30) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        try:
            return err.code, err.read().decode("utf-8")
        finally:
            err.close()


def _reject_float(value: Any, path: str = "input") -> None:
    if isinstance(value, float):
        raise ValueError(f"{path} must be a decimal string, not a float")
    if isinstance(value, dict):
        for key, child in value.items():
            _reject_float(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_float(child, f"{path}[{index}]")


def _code_of(body: Any) -> str | None:
    """`intafacedCode` from a REST refusal, or from a tRPC error's data (its `cause.code` or `intafacedCode`)."""
    if not isinstance(body, dict):
        return None
    if isinstance(body.get("intafacedCode"), str):
        return body["intafacedCode"]
    error = body.get("error")
    data = error.get("data") if isinstance(error, dict) else None
    if isinstance(data, dict):
        cause = data.get("cause")
        if isinstance(cause, dict) and isinstance(cause.get("code"), str):
            return cause["code"]
        if isinstance(data.get("intafacedCode"), str):
            return data["intafacedCode"]
    return None


def _message_of(body: Any, fallback: str) -> str:
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"]
        if isinstance(body.get("message"), str):
            return body["message"]
    return fallback


class QuantClient:
    def __init__(self, *, base_url: str, api_key: str, transport: Transport | None = None) -> None:
        if not base_url or not base_url.strip():
            raise ValueError("Strategy API base URL is not configured")
        if not api_key or not api_key.strip():
            raise ValueError("Strategy API key is not configured")
        self._base_url = base_url if base_url.endswith("/") else f"{base_url}/"
        self._api_key = api_key
        self._transport = transport or _urllib_transport

    def _send(self, method: str, path: str, *, query: str = "", body: Any = None, idempotency_key: str | None = None) -> Any:
        if body is not None:
            _reject_float(body)
        url = urllib.parse.urljoin(self._base_url, path) + (f"?{query}" if query else "")
        headers = {"accept": "application/json", "authorization": f"Bearer {self._api_key}"}
        raw = None
        if body is not None:
            raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            headers["content-type"] = "application/json"
        if idempotency_key is not None:
            headers["idempotency-key"] = idempotency_key
        status, text = self._transport(method, url, headers, raw)
        try:
            # Decimals in the answer stay as the API sent them: a JSON number becomes a string, never a float.
            parsed: Any = json.loads(text, parse_float=str) if text else None
        except json.JSONDecodeError:
            parsed = text
        if status < 200 or status >= 300:
            raise QuantApiError(status, _code_of(parsed), _message_of(parsed, f"HTTP {status}"), parsed)
        return parsed

    def _query(self, procedure: str, input: dict[str, Any]) -> Any:
        _reject_float(input)
        encoded = urllib.parse.quote(json.dumps(input, separators=(",", ":"), ensure_ascii=False), safe="")
        return _unwrap(self._send("GET", _QUANT + procedure, query=f"input={encoded}"))

    # quant:read
    def list_strategies(self, limit: int | None = None) -> Any:
        return self._query("studio.list", {} if limit is None else {"limit": limit})

    def get_strategy(self, strategy_id: str) -> Any:
        return self._query("studio.get", {"id": _required(strategy_id, "strategy_id")})

    def backtest_history(self, limit: int | None = None) -> Any:
        return self._query("backtest.history", {} if limit is None else {"limit": limit})

    def backtest_result(self, run_id: str) -> Any:
        return self._query("backtest.result", {"runId": _required(run_id, "run_id")})

    def backtest_report(self, run_id: str) -> Any:
        return self._query("backtest.report", {"runId": _required(run_id, "run_id")})

    # quant:run
    def start_backtest(self, input: dict[str, Any], idempotency_key: str) -> Any:
        """Starts a backtest. `idempotency_key` is your business key (1 to 128 visible characters, no spaces)."""
        key = _required(idempotency_key, "idempotency_key")
        if not (1 <= len(key) <= 128) or any(not ("\x21" <= c <= "\x7e") for c in key):
            raise ValueError("idempotency_key must be 1 to 128 printable characters with no spaces")
        return _unwrap(self._send("POST", _QUANT + "backtest.start", body=input, idempotency_key=key))

    # trade:read / trade:write
    def list_live_runs(self) -> Any:
        return self._send("GET", _LIVE)

    def stop_live_run(self, run_id: str, seq: int) -> Any:
        """Stops a live run under its sequence number: open orders cancelled, position kept."""
        return self._send("POST", f"{_LIVE}/{_segment(run_id)}/stop", body={"seq": _seq(seq)})

    def liquidate_live_run(self, run_id: str, seq: int) -> Any:
        """Stops a live run, then one reduce-only close per position."""
        return self._send("POST", f"{_LIVE}/{_segment(run_id)}/liquidate", body={"seq": _seq(seq)})


def _unwrap(body: Any) -> Any:
    if isinstance(body, dict) and isinstance(body.get("result"), dict):
        data = body["result"].get("data")
        if isinstance(data, dict) and "json" in data:
            return data["json"]
        return data
    return body


def _required(value: str, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} is required")
    return value


def _segment(run_id: str) -> str:
    return urllib.parse.quote(_required(run_id, "run_id"), safe="")


def _seq(seq: int) -> int:
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 1:
        raise ValueError("seq must be a positive integer")
    return seq


# The sandbox's Python starter, the same text as the customer app's (apps/customer/src/features/quant/python-template.ts).
# The sandbox runs a small Python subset: assignments, a one-line `if ...:` body, `print`, and the `market`, `oms` and
# `book` objects, with no imports, functions or loops. One limit buy below the TEST mark, and one order of quantity
# zero, which the sandbox records as a rejected event.
_TEMPLATE = """a = oms.limitBuy("BTC-USD", "0.01", "49990", "gtc")
z = oms.limitBuy("BTC-USD", "0", "49990", "gtc")
print(z.status)
print(z.reason)"""


def strategy_template() -> str:
    """The source of a minimal Python strategy that the INTAFACED sandbox runs."""
    return _TEMPLATE
