"""Generated from the Payments OpenAPI document. Do not edit.

Regenerate: pnpm exec tsx tooling/scripts/sdk-from-openapi.ts
"""

from __future__ import annotations

from intafaced_pay.client import PayClient


class PayOperations:
    def __init__(self, client: PayClient) -> None:
        self._client = client

    def get_balances(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """GET /balances — Merchant balance for one asset"""
        return self._client.call(
            "GET",
            "/balances",
            body=body,
            query=query,
            params=params,
            idempotency=False,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def get_payment_links(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """GET /payment-links — List a merchant’s payment links, newest first"""
        return self._client.call(
            "GET",
            "/payment-links",
            body=body,
            query=query,
            params=params,
            idempotency=False,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def post_payment_links(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """POST /payment-links — Create a payment link"""
        return self._client.call(
            "POST",
            "/payment-links",
            body=body,
            query=query,
            params=params,
            idempotency=True,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def delete_payment_links_by_id(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """DELETE /payment-links/{id} — Deactivate a payment link"""
        return self._client.call(
            "DELETE",
            "/payment-links/{id}",
            body=body,
            query=query,
            params=params,
            idempotency=False,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def get_payments(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """GET /payments — List a merchant’s payments, newest first"""
        return self._client.call(
            "GET",
            "/payments",
            body=body,
            query=query,
            params=params,
            idempotency=False,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def post_payments(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """POST /payments — Create a payment"""
        return self._client.call(
            "POST",
            "/payments",
            body=body,
            query=query,
            params=params,
            idempotency=True,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def get_payments_by_id(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """GET /payments/{id} — Fetch one payment"""
        return self._client.call(
            "GET",
            "/payments/{id}",
            body=body,
            query=query,
            params=params,
            idempotency=False,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def post_payments_by_id_authorize(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """POST /payments/{id}/authorize — Authorize a payment"""
        return self._client.call(
            "POST",
            "/payments/{id}/authorize",
            body=body,
            query=query,
            params=params,
            idempotency=True,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def post_payments_by_id_capture(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """POST /payments/{id}/capture — Capture an authorized payment"""
        return self._client.call(
            "POST",
            "/payments/{id}/capture",
            body=body,
            query=query,
            params=params,
            idempotency=True,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def post_payments_by_id_refund(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """POST /payments/{id}/refund — Refund a captured payment"""
        return self._client.call(
            "POST",
            "/payments/{id}/refund",
            body=body,
            query=query,
            params=params,
            idempotency=True,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def get_submerchant_permissions(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """GET /submerchant-permissions — Live grants over a subject merchant (implicit root/self authority omitted)"""
        return self._client.call(
            "GET",
            "/submerchant-permissions",
            body=body,
            query=query,
            params=params,
            idempotency=False,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def get_submerchant_permissions_areas(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """GET /submerchant-permissions/areas — Permission area vocabulary (eleven surfaces; not fourteen)"""
        return self._client.call(
            "GET",
            "/submerchant-permissions/areas",
            body=body,
            query=query,
            params=params,
            idempotency=False,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def post_submerchant_permissions_grant(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """POST /submerchant-permissions/grant — Grant an area the caller already holds (reason required; append-only journal)"""
        return self._client.call(
            "POST",
            "/submerchant-permissions/grant",
            body=body,
            query=query,
            params=params,
            idempotency=True,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def get_submerchant_permissions_history(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """GET /submerchant-permissions/history — Grant and revoke journal for a subject, newest first"""
        return self._client.call(
            "GET",
            "/submerchant-permissions/history",
            body=body,
            query=query,
            params=params,
            idempotency=False,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def post_submerchant_permissions_revoke(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """POST /submerchant-permissions/revoke — Revoke a live grant — new journal row, never an edit"""
        return self._client.call(
            "POST",
            "/submerchant-permissions/revoke",
            body=body,
            query=query,
            params=params,
            idempotency=True,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def get_webhook_deliveries(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """GET /webhook-deliveries — Webhook delivery dashboard (failures / dead / all)"""
        return self._client.call(
            "GET",
            "/webhook-deliveries",
            body=body,
            query=query,
            params=params,
            idempotency=False,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def get_webhook_endpoints(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """GET /webhook-endpoints — List webhook endpoints for a merchant"""
        return self._client.call(
            "GET",
            "/webhook-endpoints",
            body=body,
            query=query,
            params=params,
            idempotency=False,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def post_webhook_endpoints(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """POST /webhook-endpoints — Register an outbound webhook endpoint"""
        return self._client.call(
            "POST",
            "/webhook-endpoints",
            body=body,
            query=query,
            params=params,
            idempotency=True,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def delete_webhook_endpoints_by_id(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """DELETE /webhook-endpoints/{id} — Disable a webhook endpoint"""
        return self._client.call(
            "DELETE",
            "/webhook-endpoints/{id}",
            body=body,
            query=query,
            params=params,
            idempotency=False,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

    def post_webhook_endpoints_by_id_enable(
        self,
        *,
        body=None,
        query=None,
        params=None,
        idempotency_key=None,
        max_retries=None,
    ):
        """POST /webhook-endpoints/{id}/enable — Re-enable a disabled webhook endpoint"""
        return self._client.call(
            "POST",
            "/webhook-endpoints/{id}/enable",
            body=body,
            query=query,
            params=params,
            idempotency=True,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
        )

