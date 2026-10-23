# Claim academy.ambassadors

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE
**owner:** nitro-agent academy-ambassadors-pay-refuse
**tracker:** `academy.ambassadors`
**branch:** `feat/academy-ambassadors-pay-refuse`
**updated:** 2026-08-16
**Class:** M (refuse-closed)

## Scope

- `packages/academy-ambassadors-pay` — `proposePay` / `payout`
- `services/svc-academy/src/ambassadors/pay.ts` (+ tests) thin consumer only

Unset `ACADEMY_AMBASSADOR_SHARE_BPS` → `academy.ambassador_rate_unset`. No default bps. No 0-as-free. No P&L profit-share. No ledger post (no ambassador-named export on tip → `academy.ambassador_recipe_unwired` when rate is set).

## Do not touch

- paper / certs / curriculum / spatial
- `router.ts` (in-flight academy PRs)
- programme / residency / existing `ifc-pay.ts`
- Shehzad chain, FE, invent rates

## Leverage

Existing residency desk + IFC refuse already on academy router + `token.staking` lobby `stakeOf` gate (not a pay rate).
