"""Merchant request signing helper. Same canonical string the edge verifies.

INTAFACED-REQ-V1, UTF-8, no trailing newline. The server holds each timestamp to
the owner's signing window, which identity checks and publishes
(requestSigningPolicy); while the window is unset every signed request is refused
(auth.request_window_unset). This helper sets no window of its own.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets

REQUEST_SIGN_VERSION = "INTAFACED-REQ-V1"
REQUEST_TIMESTAMP_HEADER = "x-intafaced-request-timestamp"
REQUEST_NONCE_HEADER = "x-intafaced-request-nonce"
REQUEST_SIGNATURE_HEADER = "x-intafaced-request-signature"

_NONCE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
_HEX = re.compile(r"^[0-9a-fA-F]+$")
_METHOD = re.compile(r"^(GET|POST|PUT|PATCH|DELETE|HEAD)$")


def hash_body(body: bytes | str | None) -> str:
    if body is None:
        raw = b""
    elif isinstance(body, str):
        raw = body.encode("utf-8")
    else:
        raw = body
    return hashlib.sha256(raw).hexdigest()


def canonical_request(*, method: str, path: str, timestamp: str, nonce: str, body_hash: str) -> str:
    return "\n".join([REQUEST_SIGN_VERSION, method.upper(), path, timestamp, nonce, body_hash])


def sign_request(secret: str, canonical: str) -> str:
    return hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


def signatures_equal(provided: str, expected: str) -> bool:
    """Constant-time on the decoded bytes. A length mismatch returns false."""
    if not _HEX.fullmatch(provided) or not _HEX.fullmatch(expected):
        return False
    left = bytes.fromhex(provided)
    right = bytes.fromhex(expected)
    if len(left) != len(right) or len(left) == 0:
        return False
    return hmac.compare_digest(left, right)


def new_request_nonce() -> str:
    return secrets.token_urlsafe(16)


def sign_pay_request(
    *,
    secret: str,
    method: str,
    path: str,
    timestamp: str,
    nonce: str,
    body: bytes | str | None = None,
) -> dict[str, str]:
    if not secret:
        raise ValueError("signing secret is not configured")
    method_up = method.upper()
    if not _METHOD.fullmatch(method_up):
        raise ValueError("request method is not signable")
    if not path.startswith("/") or "://" in path or any(ch.isspace() for ch in path):
        raise ValueError("request path is not an absolute path")
    if not re.fullmatch(r"\d{1,16}", timestamp):
        raise ValueError("timestamp is not unix seconds")
    if not _NONCE.fullmatch(nonce):
        raise ValueError("nonce is not usable")
    body_hash = hash_body(body)
    canonical = canonical_request(method=method_up, path=path, timestamp=timestamp, nonce=nonce, body_hash=body_hash)
    return {
        "timestamp": timestamp,
        "nonce": nonce,
        "body_hash": body_hash,
        "signature": sign_request(secret, canonical),
        "canonical": canonical,
    }
