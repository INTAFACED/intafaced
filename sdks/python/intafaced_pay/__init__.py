"""INTAFACED merchant Payments client. Private. Not published."""

from intafaced_pay.client import DEFAULT_MAX_RETRIES, PayClient
from intafaced_pay.operations import PayOperations
from intafaced_pay.sign import (
    REQUEST_SIGN_VERSION,
    REQUEST_SIGN_WINDOW_SECONDS,
    sign_pay_request,
    signatures_equal,
)

__all__ = [
    "DEFAULT_MAX_RETRIES",
    "PayClient",
    "PayOperations",
    "REQUEST_SIGN_VERSION",
    "REQUEST_SIGN_WINDOW_SECONDS",
    "sign_pay_request",
    "signatures_equal",
]


def create_pay_client(**options: object) -> tuple[PayClient, PayOperations]:
    client = PayClient(**options)  # type: ignore[arg-type]
    return client, PayOperations(client)
