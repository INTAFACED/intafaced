# Claim pay.subscriptions (card mandate stays rail-absent)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** pr-open
**proof:** https://github.com/Phantom-X-007/intafaced/pull/1853
**tracker:** `pay.subscriptions` (not re-opened — card acquiring / pre-charge delivery remain parked sockets)
**branch:** `feat/pay-subscriptions-mandate-rail-absent`
**class:** M
**owner:** Phantom-X-007 (Denon agent)

Recurring money path stays crypto invoice-and-watch only. Card mandate refuses `pay.mandate_rail_absent`. No invented pull, no dunning magnitudes, no card acquiring. `PAY_REGISTER_CARD_SANDBOX` stays off in ship postures.

## Leverage

Phase A IN: existing svc-pay mandate/subscription (`mandate-product.ts` + fire `mandateChargeDisposition`). Horizon `pay.subscriptions` = IN.

## Non-goals

- Dual-edit #1848 KYB money-gate (`payment-service.ts`, `subscription-service.ts`, `subscription-router.ts`, `index.ts`, KYB helpers)
- Dual-edit #1841 svc-agents, #1845 svc-academy, #1846 svc-identity, #1849 svc-ws
- Invent charge-against-mandate / Hyperswitch
- Mark tracker mountain `done` from this slice
