# Claim pay.gateway (merchant eligibility race hardening)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** claimed
**tracker:** `pay.gateway` (existing ready mountain; no tracker status change)
**branch:** `feat/pay-checkout-kyb-enforcement`
**class:** M
**owner:** Nitro Codex

Serialize the existing merchant status/KYB eligibility decision with
`payment.create`, `checkout.open`, `payment.authorize`, and `payment.capture`.
Prove concurrent reject/suspend cannot race a stale merchant snapshot into a
new payment action, while completed retries remain idempotent.

## Leverage

Phase A `S-PAY`: extend the existing `svc-pay` checkout, merchant-state, KYB,
rail, and ledger-recipe paths. Full-horizon `pay.gateway` is `IN+X`; this is the
in-repo enforcement slice only. No acquirer, grantor, partner, geo policy, card
live claim, or second money book.

## Non-goals

- No `packages/ledger-client`, contracts, events, or another service.
- No KYB decision policy or automatic suspension rule.
- No tracker status-only reconciliation; its stale prose is recorded as a
  residual for a later genuine mountain event.
