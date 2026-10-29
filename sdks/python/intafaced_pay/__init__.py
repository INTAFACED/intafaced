"""INTAFACED merchant Payments client. Private. Not published."""

from intafaced_pay.client import DEFAULT_MAX_RETRIES, PayClient
from intafaced_pay.operations import PayOperations
from intafaced_pay.payment_links_page import PayPaymentLinkPage, payment_link_page_from_response
from intafaced_pay.payments_page import PayPaymentPage, payment_page_from_response
from intafaced_pay.sign import (
    REQUEST_SIGN_VERSION,
    sign_pay_request,
    signatures_equal,
)

__all__ = [
    "DEFAULT_MAX_RETRIES",
    "PayClient",
    "PayOperations",
    "PayPaymentLinkPage",
    "PayPaymentPage",
    "REQUEST_SIGN_VERSION",
    "payment_link_page_from_response",
    "payment_page_from_response",
    "sign_pay_request",
    "signatures_equal",
]


def create_pay_client(**options: object) -> tuple[PayClient, PayOperations]:
    client = PayClient(**options)  # type: ignore[arg-type]
    return client, PayOperations(client)
