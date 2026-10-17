# pay.plugins — reference path + WooCommerce adapter

**Date:** 2026-08-10 · **Wave:** 13 L02 · **Closed:** D26-P1-P8 2026-08-12 · **Woo slice:** 2026-08-16 · **Class:** N/M

## Decision

The **shared contract** is the TypeScript reference client plus frozen webhook vectors. We do **not** restamp that client as if it were WooCommerce.

**Product paths:**

1. **TypeScript reference client** — `services/svc-pay/src/plugins/reference-client.ts`  
   Builds public API requests with the real contract pins (Bearer key, Idempotency-Key, decimal-string amounts, `/api/pay/v1` paths).
2. **Payment lifecycle helpers** — create / get / authorize / capture / refund.
3. **Webhook install path** — register endpoint (https only), list endpoints, list deliveries, verify HMAC vectors.
4. **Frozen webhook signature vectors** — `services/svc-pay/src/plugins/webhook-vectors.ts`  
   HMAC-SHA256 over `timestamp + "." + raw body`; must match `rails/webhook-signature.signPayload` and outbound `X-Intafaced-Signature`.
5. **WooCommerce adapter** — `plugins/woocommerce-intafaced-pay/`  
   PHP checkout + webhook handler that **consumes** the same pins. Contract tests: `woocommerce-contract.test.ts`.
6. **Magento / OpenCart** — still §13 (`pay.plugin_cms_unwired`). Not this PR.

Greenfield is the CMS adapter only — not a second pay stack or money book (Phase B `pay.plugins` GF LATE). Phase A leverage: `pay.public-api` + reference-client + webhook-vectors.

## Done bar (Woo slice)

- Woo plugin creates a payment via existing public API (`PAY_PUBLIC_API_BASE` `/api/pay/v1`, Bearer, Idempotency-Key, decimal string amounts).
- Merchant webhooks verify with the frozen HMAC vectors.
- Sandbox vs live key mode (`ifc_test_` / `ifc_`).
- Tests fail if the public contract pins drift.
- No second money book. No PSP invent.

## Not this mountain

| Item                         | Why parked                      |
| ---------------------------- | ------------------------------- |
| Magento / OpenCart PHP       | §13 `socket.pay-plugin-cms-php` |
| `pay:*` grant path           | Nitro DIRECTION §8              |
| Live acquirer plugin listing | Class X / partner               |
