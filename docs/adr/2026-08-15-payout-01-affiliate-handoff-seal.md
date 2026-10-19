# ADR: PAYOUT-01 affiliate payout handoff — v1 defaults sealed

**Status:** **Accepted — 2026-08-15 (PAYOUT-01).** Recommended defaults from `OWNER-RULINGS-FROM-DENON-PAYOUT-2026-08-09.md` (removed) are clicked as v1 law. No override.
**Decision owner:** Denon.
**Packet:** `PAYOUT-01` in [`ops/owner-ruling-packet.json`](../ops/owner-ruling-packet.json).
**Lane:** `denon-payout-01-handoff`.
**Not this card:** commission **magnitudes** stay **D26-P0-02**. This ADR does not invent hop counts, bps, or a new ledger recipe.

---

## Clicked (v1 law)

| Decision                 | Accepted default                                                                                                                              | Named home (do not edit in this PR)                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Max commissionable hops  | **`MAX_PAYOUT_TIER_DEPTH` = 5** (same as referral tree write cap `DEFAULT_MAX_REFERRAL_DEPTH`)                                                | `services/svc-identity/src/affiliates/payout-engine.ts`                   |
| Fee pool source module   | Keep **`AFFILIATE_PAYOUT_SOURCE_MODULE` = `"identity"`** as the named plan-level default, plus the existing override / per-row `sourceModule` | same file + `commission.ts` `DEFAULT_AFFILIATE_FEE_SOURCE_MODULE`         |
| Atomic multi-leg payout  | **Replay-safe by business key.** Crash mid-fan-out may leave a partial tree; re-run completes; nobody is paid twice                           | `affiliatePayoutRowKey` → `affiliate:<feeEventId>:<beneficiaryId>:h<hop>` |
| Multi-beneficiary recipe | **Do not invent.** Fan-out stays existing `sweepFeesToRewards` + `rewardPay` (DIRECTION §3 carve-out)                                         | `packages/ledger-client` recipes already used by the engine               |

Raise or lower depth, change the default pool name, or add a multi-beneficiary recipe **only after written law**. Agents must not invent a fifth hop, a new rate, or a batch post.

---

## What this does **not** seal

- Affiliate / IB **commission bps** and fee-share magnitudes — **D26-P0-02**.
- Publishing live commission tables, notify credentials, or mark sources (Class X / later).
- A `sourceModule` column shape beyond what already landed for producers.

Until owner-published tiers exist for a hop, the **existing** payout engine stays refuse-closed: unpublished law → `affiliate.payout.rates_unset`; row rate not matching published law → `affiliate.payout.rate_unpublished`; **balances do not move**. That refuse is already the deliverable (#1505). This seal does not reopen it.

---

## Path fence

Docs / packet / LIVE-LANES only. **Do not edit** `payout-engine.ts`, Vue, `svc-edge`, or invent identity money paths.
