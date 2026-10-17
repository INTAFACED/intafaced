# L3 pack — ops.support Stage-2 operator queue API

**Class:** N (queue prioritisation + exclusive claim; no money)  
**Does NOT invent L1/L2.** No refund ledger recipes; no invent SLAs as currency.

## Outcome

Operators can `listQueue` (category+age score), `next` (peek), and `claim` (exclusive assignee) on open/pending tickets via `svc-support` staff API.

## Non-goals

- No apps/admin UI this slice (residual)
- No identity/ledger account panel
- No refund money / ledger post
- No agents.support grounding invent

## Done bar

- [x] Wire existing `operator-queue.ts` into `SupportService`
- [x] Router `listQueue` / `next` / `claim` (`support:ops`)
- [x] Service + mount authority tests green
- [x] Ready reports `2-memory-queue`

## Paths allowlist

```
docs/ops/claims/TRK-ops.support.md
docs/ops/slices/L3-2026-08-07-ops-support-stage2-queue.md
docs/ops/trk/ops.support.md
services/svc-support/README.md
services/svc-support/src/index.ts
services/svc-support/src/router.ts
services/svc-support/src/router.mount.test.ts
services/svc-support/src/support-service.ts
services/svc-support/src/support-service.test.ts
tooling/tracker/features.mjs
```

## Consumer

`services/svc-support/src/router.ts` — `support.listQueue` / `support.next` / `support.claim`

## Board-Delta

L3 Class N: ops.support Stage-2 operator queue API (listQueue/next/claim).

## Leverage

Phase A IN — extend existing `svc-support` Stage-1 spine + pure `operator-queue.ts` (#798/#825). Horizon GF MID — no second desk service / SPA.
