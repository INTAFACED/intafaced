# L3 pack — ops.affiliates Stage-2 member listing + freeze honesty

**Class:** N (member roster + freeze/unfreeze honesty; no money)  
**Does NOT invent L1/L2.** No fee-share bps; no ledger post. DIRECTION §8 rates = owner-only.

## Outcome

Operators can `affiliates.members` (attributed roster, optional root filter) and receive `honestyLine` on freeze/unfreeze confirming set membership without inventing accrual/payout.

## Non-goals

- No invent commission rates / payout amounts
- No ledger recipe / Class M automation
- No shell invite leaderboard invent
- No apps/admin UI this slice

## Done bar

- [x] `listAffiliateTreeMembers` + member board / status line
- [x] Freeze/unfreeze honesty helpers
- [x] `ReferralService.listMembers`
- [x] Router `affiliates.members` + freeze/unfreeze `honestyLine`
- [x] Unit + router authority tests green

## Paths allowlist

```
docs/ops/claims/TRK-ops.affiliates.md
docs/ops/slices/L3-2026-08-07-affiliates-stage2-members.md
docs/ops/trk/ops.affiliates.md
services/svc-identity/src/affiliates/admin-tree-read.ts
services/svc-identity/src/affiliates/admin-tree-read.test.ts
services/svc-identity/src/affiliates/referral-service.ts
services/svc-identity/src/router.ts
services/svc-identity/src/router.test.ts
tooling/tracker/features.mjs
```

## Consumer

`services/svc-identity/src/router.ts` — `affiliates.members` / freeze·unfreeze `honestyLine`

## Board-Delta

L3 Class N: affiliates Stage-2 member listing + freeze/unfreeze honesty (no invent rates).

## Leverage

Phase A IN — extend `svc-identity` affiliates (existing referral tree + freeze + Stage-1 admin-tree-read). Horizon GF MID — no second service.
