"""Merchant Payments client.

A mutating POST sends one Idempotency-Key for the whole call, including retries.
Retries are only for GET, HEAD, DELETE, or a call that carries an Idempotency-Key.
Delay is exponential with jitter, unless the response carries Retry-After.
Each signed attempt uses a new nonce and timestamp. Amount fields must be decimal
strings. A blank base URL or API key refuses. There is no default host.
"""

from __future__ import annotations

import calendar
import json
import random
import re
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from email.message import Message
from typing import Any

from intafaced_pay.sign import (
    REQUEST_NONCE_HEADER,
    REQUEST_SIGNATURE_HEADER,
    REQUEST_TIMESTAMP_HEADER,
    new_request_nonce,
    sign_pay_request,
)

DEFAULT_MAX_RETRIES = 2

Transport = Callable[[str, str, dict[str, str], bytes | None], tuple[int, str] | tuple[int, str, str | None]]

# Client transport ceiling so a Retry-After cannot stall the process. Not a server business TTL.
_MAX_RETRY_DELAY_S = 60.0
_SAFE_RETRY_METHODS = {"GET", "HEAD", "DELETE"}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


def _retry_after_header(headers: Message | None) -> str | None:
    if headers is None:
        return None
    value = headers.get("Retry-After")
    return value if isinstance(value, str) and value.strip() else None


def _urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, str, str | None]:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=30) as response:
            return response.status, response.read().decode("utf-8"), _retry_after_header(response.headers)
    except urllib.error.HTTPError as err:
        try:
            raw = err.read().decode("utf-8")
            return err.code, raw, _retry_after_header(err.headers)
        finally:
            err.close()


def _split_transport(result: tuple[int, str] | tuple[int, str, str | None]) -> tuple[int, str, str | None]:
    if len(result) >= 3:
        return result[0], result[1], result[2]
    return result[0], result[1], None


def _retry_after_seconds(raw: str | None, now_s: float) -> float | None:
    if raw is None:
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None
    if trimmed.isdigit():
        return min(float(int(trimmed)), _MAX_RETRY_DELAY_S)
    parsed = _http_date(trimmed)
    if parsed is None:
        return None
    return min(max(0.0, parsed - now_s), _MAX_RETRY_DELAY_S)


def _http_date(value: str) -> float | None:
    try:
        return float(calendar.timegm(time.strptime(value, "%a, %d %b %Y %H:%M:%S GMT")))
    except ValueError:
        return None


def retry_delay_seconds(attempt: int, retry_after: str | None, now_s: float, random_fn: Callable[[], float]) -> float:
    header = _retry_after_seconds(retry_after, now_s)
    if header is not None:
        return header
    ceiling = 0.1 * (2**attempt)
    jitter = max(0.0, min(0.999999, random_fn())) * ceiling
    return (ceiling / 2) + jitter


def _may_retry(method: str, idempotency_key: str | None) -> bool:
    if method.upper() in _SAFE_RETRY_METHODS:
        return True
    return bool(idempotency_key and idempotency_key.strip())


def _retry_budget(value: int | None, fallback: int) -> int:
    chosen = fallback if value is None else value
    if isinstance(chosen, bool) or not isinstance(chosen, int) or chosen < 0:
        raise ValueError("maxRetries must be a non-negative integer")
    return chosen


def _reject_numeric_amount(value: Any, path: str = "body") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "amount" and isinstance(child, (int, float)) and not isinstance(child, bool):
                raise ValueError(f"{path}.{key} must be a decimal string")
            _reject_numeric_amount(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_numeric_amount(child, f"{path}[{index}]")


def _fill_path(template: str, params: dict[str, str] | None) -> str:
    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        value = None if params is None else params.get(name)
        if not value:
            raise ValueError(f"path parameter {name} is not configured")
        return urllib.parse.quote(value, safe="")

    return re.sub(r"\{([^}]+)\}", replace, template)


def _request_url(base_url: str, path: str, query: dict[str, str | None] | None) -> tuple[str, str]:
    base = base_url if base_url.endswith("/") else f"{base_url}/"
    joined = urllib.parse.urljoin(base, path.lstrip("/"))
    parts = urllib.parse.urlsplit(joined)
    pairs: list[tuple[str, str]] = []
    if query:
        for key in sorted(query):
            value = query[key]
            if value is not None:
                pairs.append((key, value))
    search = urllib.parse.urlencode(pairs)
    url = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, search, ""))
    signed = parts.path + (f"?{search}" if search else "")
    return url, signed


class PayClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        signing_secret: str | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        transport: Transport | None = None,
        now: Callable[[], float] | None = None,
        nonce: Callable[[], str] | None = None,
        new_idempotency_key: Callable[[], str] | None = None,
        sleep: Callable[[float], None] | None = None,
        random_fn: Callable[[], float] | None = None,
    ) -> None:
        if not base_url or not base_url.strip():
            raise ValueError("Payments API base URL is not configured")
        if not api_key or not api_key.strip():
            raise ValueError("Payments API key is not configured")
        self._base_url = base_url
        self._api_key = api_key
        self._signing_secret = signing_secret
        self._max_retries = _retry_budget(max_retries, DEFAULT_MAX_RETRIES)
        self._transport = transport or _urllib_transport
        self._now = now or _time_ms
        self._nonce = nonce or new_request_nonce
        self._new_idempotency_key = new_idempotency_key or (lambda: str(uuid.uuid4()))
        self._sleep = sleep or time.sleep
        self._random = random_fn or random.random

    def call(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        query: dict[str, str | None] | None = None,
        body: Any = None,
        idempotency: bool = False,
        idempotency_key: str | None = None,
        max_retries: int | None = None,
    ) -> dict[str, Any]:
        if body is not None:
            _reject_numeric_amount(body)
        filled = _fill_path(path, params)
        url, signed_path = _request_url(self._base_url, filled, query)
        raw = None if body is None else json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        key = idempotency_key if idempotency_key is not None else (self._new_idempotency_key() if idempotency else None)
        attempts = _retry_budget(max_retries, self._max_retries) + 1
        last_status = 0
        last_body = ""
        for attempt in range(attempts):
            headers = {
                "accept": "application/json",
                "authorization": f"Bearer {self._api_key}",
            }
            if raw is not None:
                headers["content-type"] = "application/json"
            if key:
                headers["idempotency-key"] = key
            if self._signing_secret:
                signed = sign_pay_request(
                    secret=self._signing_secret,
                    method=method,
                    path=signed_path,
                    timestamp=str(int(self._now() // 1000)),
                    nonce=self._nonce(),
                    body=raw,
                )
                headers[REQUEST_TIMESTAMP_HEADER] = signed["timestamp"]
                headers[REQUEST_NONCE_HEADER] = signed["nonce"]
                headers[REQUEST_SIGNATURE_HEADER] = signed["signature"]
            last_status, last_body, retry_after = _split_transport(self._transport(method.upper(), url, headers, raw))
            if (last_status != 429 and last_status < 500) or not _may_retry(method, key) or attempt == attempts - 1:
                break
            self._sleep(retry_delay_seconds(attempt, retry_after, self._now() / 1000, self._random))
        parsed: Any
        if not last_body:
            parsed = None
        else:
            try:
                parsed = json.loads(last_body)
            except json.JSONDecodeError:
                parsed = last_body
        return {"status": last_status, "body": parsed, "raw_body": last_body}


def _time_ms() -> float:
    return time.time() * 1000
