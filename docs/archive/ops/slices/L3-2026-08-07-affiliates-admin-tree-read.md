# L3 pack — ops.affiliates Stage admin tree read

**Class:** N (tree structure + status + admin read; payout refuse-closed)  
**Does NOT invent L1/L2.** No fee-share bps; no ledger post. DIRECTION §8 rates = owner-only.

## Outcome

Operators can read multi-tier IB/affiliate tree board + one-node status (parent, depth, ancestors, hop-0 downline, freeze). Payout mutation refuses closed with named residual.

## Non-goals

- No invent commission rates / payout amounts
- No ledger recipe / Class M automation
- No shell invite leaderboard invent
- No svc-agents / notify / support / academy paths

## Done bar

- [x] `admin-tree-read.ts` builders + refuse helper
- [x] `ReferralService.treeBoard` / `nodeStatus`
- [x] Router `affiliates.treeStatus` / `node` (`admin:read`) + `payout` refuse
- [x] Unit + router authority tests green

## Paths allowlist

```
docs/ops/claims/TRK-ops.affiliates.md
docs/ops/slices/L3-2026-08-07-affiliates-admin-tree-read.md
services/svc-identity/src/affiliates/admin-tree-read.ts
services/svc-identity/src/affiliates/admin-tree-read.test.ts
services/svc-identity/src/affiliates/referral-service.ts
services/svc-identity/src/router.ts
services/svc-identity/src/router.test.ts
```

## Consumer

`services/svc-identity/src/router.ts` — `affiliates.treeStatus` / `affiliates.node` / `affiliates.payout`

## Board-Delta

L3 Class N: affiliates Stage admin tree read + payout refuse-closed (DIRECTION §8).

## Leverage

Phase A IN — extend `svc-identity` affiliates (existing referral tree + freeze). Horizon GF MID — no second service.
