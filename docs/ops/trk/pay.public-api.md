# TRK-pay.public-api — Public REST + webhooks + sandbox (§9)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker:** `pay.public-api` · **Class:** M · **Law:** [`docs/adr/2026-08-07-pay-public-api-law.md`](../../adr/2026-08-07-pay-public-api-law.md)

## Sequence (ADR §4)

| Step | Slice                                                                                            | Status                         |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| 1    | REST translation + OpenAPI + auth — **read paths** (`get` / `list` / `balances`)                 | tip `#988`                     |
| 2    | Mutating paths — `create` / `authorize` / `capture` / `refund` behind required `Idempotency-Key` | tip `#994`                     |
| 3    | Webhooks — signing, retry, dedup, failure dashboard, enable, durable SKIP LOCKED claim           | tip `#1006` + D26-P1-P7 deepen |
| 4    | Sandbox keys — route sandbox principal to sandbox rail; payment `mode` disclosed                 | tip `#1014` + D26-P1-P7        |
| 5    | Public docs + merchant quickstart                                                                | tip `#1024`                    |

**Done bar (D26-P1-P7):** Surface + webhooks + sandbox — proved by `public-api-done-bar.test.ts`.

## Merchant surface

```
GET    /api/pay/v1/openapi.json                     public
GET    /api/pay/v1/payments/:id                     pay:read
GET    /api/pay/v1/payments                          pay:read
GET    /api/pay/v1/balances                          pay:read
POST   /api/pay/v1/payments                         pay:write   + Idempotency-Key
POST   /api/pay/v1/payments/:id/authorize           pay:write   + Idempotency-Key
POST   /api/pay/v1/payments/:id/capture             pay:write   + Idempotency-Key
POST   /api/pay/v1/payments/:id/refund              pay:refund  + Idempotency-Key
POST   /api/pay/v1/webhook-endpoints                pay:write
GET    /api/pay/v1/webhook-endpoints                pay:read
DELETE /api/pay/v1/webhook-endpoints/:id            pay:write
POST   /api/pay/v1/webhook-endpoints/:id/enable     pay:write
GET    /api/pay/v1/webhook-deliveries               pay:read   (failure dashboard)
```

## Explicitly not this row's Class X

Live card acquiring / sponsor BIN = `socket.psp-partners`. Hyperswitch stays killed (ADR 2026-08-04). Agents ship the API door + docs, not go-live.
