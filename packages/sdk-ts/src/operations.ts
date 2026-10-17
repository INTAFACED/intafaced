// Generated from the Payments OpenAPI document. Do not edit.
// Regenerate: pnpm exec tsx tooling/scripts/sdk-from-openapi.ts
import type { PayCallInput, PayClient, PayResponse } from './client.js';
import { paymentPageFromResponse, type PayPaymentPage } from './payments-page.js';

export interface PayOperations {
  /** Merchant balance for one asset */
  getBalances(input: PayCallInput): Promise<PayResponse>;
  /** List a merchant’s payment links, newest first */
  getPaymentLinks(input: PayCallInput): Promise<PayResponse>;
  /** Create a payment link */
  postPaymentLinks(input: PayCallInput): Promise<PayResponse>;
  /** Deactivate a payment link */
  deletePaymentLinksById(input: PayCallInput & { readonly params: { readonly id: string } }): Promise<PayResponse>;
  /** List a merchant’s payments, newest first */
  getPayments(input: PayCallInput): Promise<PayPaymentPage>;
  /** Create a payment */
  postPayments(input: PayCallInput): Promise<PayResponse>;
  /** Fetch one payment */
  getPaymentsById(input: PayCallInput & { readonly params: { readonly id: string } }): Promise<PayResponse>;
  /** Authorize a payment */
  postPaymentsByIdAuthorize(input: PayCallInput & { readonly params: { readonly id: string } }): Promise<PayResponse>;
  /** Capture an authorized payment */
  postPaymentsByIdCapture(input: PayCallInput & { readonly params: { readonly id: string } }): Promise<PayResponse>;
  /** Refund a captured payment */
  postPaymentsByIdRefund(input: PayCallInput & { readonly params: { readonly id: string } }): Promise<PayResponse>;
  /** Live grants over a subject merchant (implicit root/self authority omitted) */
  getSubmerchantPermissions(input: PayCallInput): Promise<PayResponse>;
  /** Permission area vocabulary (eleven surfaces; not fourteen) */
  getSubmerchantPermissionsAreas(input: PayCallInput): Promise<PayResponse>;
  /** Grant an area the caller already holds (reason required; append-only journal) */
  postSubmerchantPermissionsGrant(input: PayCallInput): Promise<PayResponse>;
  /** Grant and revoke journal for a subject, newest first */
  getSubmerchantPermissionsHistory(input: PayCallInput): Promise<PayResponse>;
  /** Revoke a live grant — new journal row, never an edit */
  postSubmerchantPermissionsRevoke(input: PayCallInput): Promise<PayResponse>;
  /** Webhook delivery dashboard (failures / dead / all) */
  getWebhookDeliveries(input: PayCallInput): Promise<PayResponse>;
  /** List webhook endpoints for a merchant */
  getWebhookEndpoints(input: PayCallInput): Promise<PayResponse>;
  /** Register an outbound webhook endpoint */
  postWebhookEndpoints(input: PayCallInput): Promise<PayResponse>;
  /** Disable a webhook endpoint */
  deleteWebhookEndpointsById(input: PayCallInput & { readonly params: { readonly id: string } }): Promise<PayResponse>;
  /** Re-enable a disabled webhook endpoint */
  postWebhookEndpointsByIdEnable(input: PayCallInput & { readonly params: { readonly id: string } }): Promise<PayResponse>;
}

export function bindOperations(client: PayClient): PayOperations {
  return {
    getBalances(input) {
      return client.call({ ...input, method: 'GET', path: '/balances', idempotency: false });
    },
    getPaymentLinks(input) {
      return client.call({ ...input, method: 'GET', path: '/payment-links', idempotency: false });
    },
    postPaymentLinks(input) {
      return client.call({ ...input, method: 'POST', path: '/payment-links', idempotency: true });
    },
    deletePaymentLinksById(input) {
      return client.call({ ...input, method: 'DELETE', path: '/payment-links/{id}', idempotency: false });
    },
    async getPayments(input) {
      const response = await client.call({ ...input, method: 'GET', path: '/payments', idempotency: false });
      return paymentPageFromResponse(response);
    },
    postPayments(input) {
      return client.call({ ...input, method: 'POST', path: '/payments', idempotency: true });
    },
    getPaymentsById(input) {
      return client.call({ ...input, method: 'GET', path: '/payments/{id}', idempotency: false });
    },
    postPaymentsByIdAuthorize(input) {
      return client.call({ ...input, method: 'POST', path: '/payments/{id}/authorize', idempotency: true });
    },
    postPaymentsByIdCapture(input) {
      return client.call({ ...input, method: 'POST', path: '/payments/{id}/capture', idempotency: true });
    },
    postPaymentsByIdRefund(input) {
      return client.call({ ...input, method: 'POST', path: '/payments/{id}/refund', idempotency: true });
    },
    getSubmerchantPermissions(input) {
      return client.call({ ...input, method: 'GET', path: '/submerchant-permissions', idempotency: false });
    },
    getSubmerchantPermissionsAreas(input) {
      return client.call({ ...input, method: 'GET', path: '/submerchant-permissions/areas', idempotency: false });
    },
    postSubmerchantPermissionsGrant(input) {
      return client.call({ ...input, method: 'POST', path: '/submerchant-permissions/grant', idempotency: true });
    },
    getSubmerchantPermissionsHistory(input) {
      return client.call({ ...input, method: 'GET', path: '/submerchant-permissions/history', idempotency: false });
    },
    postSubmerchantPermissionsRevoke(input) {
      return client.call({ ...input, method: 'POST', path: '/submerchant-permissions/revoke', idempotency: true });
    },
    getWebhookDeliveries(input) {
      return client.call({ ...input, method: 'GET', path: '/webhook-deliveries', idempotency: false });
    },
    getWebhookEndpoints(input) {
      return client.call({ ...input, method: 'GET', path: '/webhook-endpoints', idempotency: false });
    },
    postWebhookEndpoints(input) {
      return client.call({ ...input, method: 'POST', path: '/webhook-endpoints', idempotency: true });
    },
    deleteWebhookEndpointsById(input) {
      return client.call({ ...input, method: 'DELETE', path: '/webhook-endpoints/{id}', idempotency: false });
    },
    postWebhookEndpointsByIdEnable(input) {
      return client.call({ ...input, method: 'POST', path: '/webhook-endpoints/{id}/enable', idempotency: true });
    },
  };
}
