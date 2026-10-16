"""GET /payments page.

The wire body is ``{ items, nextCursor }``. ``nextCursor`` is None on the last
page. Amounts stay decimal strings. A missing pricing snapshot stays None:
the client does not invent a fee.
"""

from __future__ import annotations

import re
from typing import Any, TypedDict

_AMOUNT = re.compile(r"^\d+(\.\d{1,18})?$")
_STATUSES = frozenset({"created", "authorized", "captured", "settled", "refunded", "disputed", "failed"})
_MODES = frozenset({"live", "sandbox"})
_PAGE_SHAPE = "GET /payments returns { items, nextCursor }"
# Money on the snapshot. Basis points stay integers and are not amounts.
_SNAPSHOT_MONEY = ("flatFee", "bookedFee", "reserveAmount")


class PayFailure(TypedDict):
    code: str
    message: str


class PayPayment(TypedDict):
    id: str
    merchantId: str
    profileId: str | None
    amount: str
    assetId: str
    method: str | None
    railAdapter: str | None
    railRef: str | None
    status: str
    mode: str
    capturedAmount: str
    refundedAmount: str
    createdAt: str
    pricingSnapshot: dict[str, Any] | None
    failure: PayFailure | None


class PayPaymentPage(TypedDict):
    items: list[PayPayment]
    nextCursor: str | None


def _record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} is not an object")
    return value


def _decimal(value: Any, label: str) -> str:
    if isinstance(value, bool) or not isinstance(value, str) or _AMOUNT.fullmatch(value) is None:
        raise ValueError(f"{label} must be a decimal string")
    return value


def _required_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or value == "":
        raise ValueError(f"{label} is missing")
    return value


def _nullable_string(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} is not a string")
    return value


def _pricing_snapshot(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    record = _record(value, "payments pricing snapshot")
    _decimal(record.get("fee"), "payments pricing snapshot fee")
    for key in _SNAPSHOT_MONEY:
        child = record.get(key)
        if child is None:
            continue
        _decimal(child, f"payments pricing snapshot {key}")
    return dict(record)


def _failure(value: Any) -> PayFailure | None:
    if value is None:
        return None
    record = _record(value, "payments failure")
    return {
        "code": _required_string(record.get("code"), "payments failure code"),
        "message": _required_string(record.get("message"), "payments failure message"),
    }


def _payment(value: Any, index: int) -> PayPayment:
    record = _record(value, f"payments list item {index}")
    status = record.get("status")
    if status not in _STATUSES:
        raise ValueError("payments list item status is not a payment status")
    mode = record.get("mode")
    if mode not in _MODES:
        raise ValueError("payments list item mode is not live or sandbox")
    return {
        "id": _required_string(record.get("id"), f"payments list item {index} id"),
        "merchantId": _required_string(record.get("merchantId"), f"payments list item {index} merchantId"),
        "profileId": _nullable_string(record.get("profileId"), f"payments list item {index} profileId"),
        "amount": _decimal(record.get("amount"), f"payments list item {index} amount"),
        "assetId": _required_string(record.get("assetId"), f"payments list item {index} assetId"),
        "method": _nullable_string(record.get("method"), f"payments list item {index} method"),
        "railAdapter": _nullable_string(record.get("railAdapter"), f"payments list item {index} railAdapter"),
        "railRef": _nullable_string(record.get("railRef"), f"payments list item {index} railRef"),
        "status": status,
        "mode": mode,
        "capturedAmount": _decimal(record.get("capturedAmount"), f"payments list item {index} capturedAmount"),
        "refundedAmount": _decimal(record.get("refundedAmount"), f"payments list item {index} refundedAmount"),
        "createdAt": _required_string(record.get("createdAt"), f"payments list item {index} createdAt"),
        "pricingSnapshot": _pricing_snapshot(record.get("pricingSnapshot")),
        "failure": _failure(record.get("failure")),
    }


def parse_payment_page(body: Any) -> PayPaymentPage:
    """Accept a 200 body that is a page. A bare array is refused."""
    if isinstance(body, list) or not isinstance(body, dict) or not isinstance(body.get("items"), list) or "nextCursor" not in body:
        raise ValueError(_PAGE_SHAPE)
    cursor = body["nextCursor"]
    if cursor is not None and not isinstance(cursor, str):
        raise ValueError("payments nextCursor is not a string")
    return {"items": [_payment(item, index) for index, item in enumerate(body["items"])], "nextCursor": cursor}


def payment_page_from_response(response: dict[str, Any]) -> PayPaymentPage:
    status = response.get("status")
    if status != 200:
        body = response.get("body")
        code = ""
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict) and isinstance(error.get("code"), str):
                code = error["code"]
        raise ValueError(f"payments list refused: {code}" if code else f"payments list refused ({status})")
    return parse_payment_page(response.get("body"))
