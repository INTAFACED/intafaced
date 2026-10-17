"""GET /payment-links page.

The wire body is ``{ items, nextCursor }``. ``nextCursor`` is None on the last
page. An amount is a decimal string or None. A JSON number is refused.
"""

from __future__ import annotations

import re
from typing import Any, TypedDict

_AMOUNT = re.compile(r"^\d+(\.\d{1,18})?$")
_PAGE_SHAPE = "GET /payment-links returns { items, nextCursor }"


class PayPaymentLink(TypedDict):
    id: str
    prefix: str
    label: str
    amount: str | None
    currency: str | None
    active: bool
    expiresAt: str | None
    maxUses: int | None
    uses: int
    createdAt: str


class PayPaymentLinkPage(TypedDict):
    items: list[PayPaymentLink]
    nextCursor: str | None


def _record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} is not an object")
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


def _amount(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, str) or _AMOUNT.fullmatch(value) is None:
        raise ValueError(f"{label} must be a decimal string")
    return value


def _integer(value: Any, label: str, nullable: bool) -> int | None:
    if nullable and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{label} is not an integer")
    return value


def _link(value: Any, index: int) -> PayPaymentLink:
    record = _record(value, f"payment links list item {index}")
    active = record.get("active")
    if not isinstance(active, bool):
        raise ValueError(f"payment links list item {index} active is not a boolean")
    uses = _integer(record.get("uses"), f"payment links list item {index} uses", False)
    return {
        "id": _required_string(record.get("id"), f"payment links list item {index} id"),
        "prefix": _required_string(record.get("prefix"), f"payment links list item {index} prefix"),
        "label": _required_string(record.get("label"), f"payment links list item {index} label"),
        "amount": _amount(record.get("amount"), f"payment links list item {index} amount"),
        "currency": _nullable_string(record.get("currency"), f"payment links list item {index} currency"),
        "active": active,
        "expiresAt": _nullable_string(record.get("expiresAt"), f"payment links list item {index} expiresAt"),
        "maxUses": _integer(record.get("maxUses"), f"payment links list item {index} maxUses", True),
        "uses": 0 if uses is None else uses,
        "createdAt": _required_string(record.get("createdAt"), f"payment links list item {index} createdAt"),
    }


def parse_payment_link_page(body: Any) -> PayPaymentLinkPage:
    """Accept a 200 body that is a page. A bare array is refused."""
    if isinstance(body, list) or not isinstance(body, dict) or not isinstance(body.get("items"), list) or "nextCursor" not in body:
        raise ValueError(_PAGE_SHAPE)
    cursor = body["nextCursor"]
    if cursor is not None and not isinstance(cursor, str):
        raise ValueError("payment links nextCursor is not a string")
    return {"items": [_link(item, index) for index, item in enumerate(body["items"])], "nextCursor": cursor}


def payment_link_page_from_response(response: dict[str, Any]) -> PayPaymentLinkPage:
    status = response.get("status")
    if status != 200:
        body = response.get("body")
        code = ""
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict) and isinstance(error.get("code"), str):
                code = error["code"]
        raise ValueError(f"payment links list refused: {code}" if code else f"payment links list refused ({status})")
    return parse_payment_link_page(response.get("body"))
