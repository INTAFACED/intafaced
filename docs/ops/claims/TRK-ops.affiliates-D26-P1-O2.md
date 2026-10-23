# Claim TRK-ops.affiliates — D26-P1-O2

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Lane:** `d26-p1-o2-affiliates`  
**Owner session:** Phantom-X-007 (Denon)  
**Board:** D26-P1-O2 — Accrual tree under rate authority  
**Branch:** `feat/ops-affiliates-o2-rate-authority`

## Scope

- Durable accrual walks the referral tree only under owner-published
  `IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON`.
- Unset / unpublished → `affiliate.accrual.rates_unset`.
- Per-call tiers on durable accrue → `affiliate.accrual.invent_refused`.
- Dry-run may simulate tiers (not written).
- Stage treeStatus (tip #996/#1008) surfaces `rateAuthorityPublished` + status
  line — never invents commission percentages into the board.
- Payout remains existing ledger-client recipes only (`sweepFeesToRewards` +
  `rewardPay`) — no new recipes, no invent commissions.

## Do not touch

- `packages/ledger-client` recipe bodies
- Nitro #1746 money-routing graph paths beyond necessary router wire
- Fabricated referral leaderboards / shell UI
