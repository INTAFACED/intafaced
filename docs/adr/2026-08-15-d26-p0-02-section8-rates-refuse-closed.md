# ADR: D26-P0-02 DIRECTION §8 rates / fee-shares — explicit launch-closed

**Status:** **Accepted as launch-closed — 2026-08-15.** Mechanism is refuse-closed. Magnitudes remain unpublished until the owner writes them into **config authority**, not source seeds.
**Decision owner (magnitudes):** Nitro / host (DIRECTION §8 item 10).
**Mechanism owner (this document):** Denon.
**Board:** `DENON-HARD-PARALLEL-BOARD-2026-08-09.md` (removed) **D26-P0-02**.
**Packet:** `OWNER-DECISION-PACKET-2026-08-09.md` (removed) §3; index `docs/ops/owner-ruling-packet.json` (removed) row `D26-P0-02` only.
**Law cited:** `DIRECTION-2026-07-31.md` (removed) §8 item 10 — `leader_share_bps` and every other fee-share rate are owner-only.
**Pattern (already on tip — do not re-implement here):** `COPY_FEE_SHARE_RESIDUAL` in `services/svc-trade/src/copy/errors.ts` — decline the surface and name the residual rather than inventing a rate.

This ADR does **not** invent bps, percents, caps, decay, hop rates, commission floors, or PSP price rows. It does **not** edit `svc-trade` / `svc-identity` / `svc-market` / Vue / `svc-edge`.

---

## The decision

> **Until the owner publishes each named parameter into config authority, the gated surface stays refuse-closed and says so. A seeded rate in source (or in an ADR JSON block) is not authority. Agents must not invent, copy-forward, or “confirm” a number to unblock a door.**

Done bar for **D26-P0-02:** explicit launch-closed on the four fee-share surfaces below. Named params in an owner-operated config store would also satisfy the mountain; that store is empty for these four, so launch-closed is the seal.

---

## Refuse-closed parameters (no magnitudes)

| Named param (authority key)                                           | Surface it gates            | Residual posture until owner publish                                                                      |
| --------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Copy `leader_share` (`leader_share_bps` / `TRADE_COPY_FEE_SHARE_LAW`) | `trade.copy` payout         | Same as `COPY_FEE_SHARE_RESIDUAL`: DIRECTION §8 / D26-P0-02 — refuse-closed, never invent fee-share rates |
| Market commission                                                     | `market.commerce` house cut | Refuse-blank; silence is not a decided zero                                                               |
| Affiliate commission tiers                                            | `ops.affiliates` accrual    | Refuse-unset / invent-refused; no hop table from source                                                   |
| Pay fee table                                                         | PSP pricing surfaces        | Refuse-closed until owner publishes the table into config authority (not a seed in git)                   |

Copy **jurisdiction list** is **D26-P0-15**, not this mountain. This ADR does not publish geo.

---

## Why source seeds are not a ruling

DIRECTION §8 item 10 forbids agents from deciding `leader_share_bps` and every other fee-share rate. Packet §3 already answered the **mechanism**: a surface whose rate is unset is refuse-closed; it does not fall back to a source seed, a zero, or a “sensible default.”

`COPY_FEE_SHARE_RESIDUAL` is the model:

```
COPY_FEE_SHARE_RESIDUAL =
  'DIRECTION §8 / D26-P0-02 leader_share_bps is owner-only — refuse-closed (never invent fee-share rates)'
```

That string is law-shaped copy, not a rate. Market commission, affiliate tiers, and pay fee tables follow the same shape: named residual, closed door, no invented number.

A later document that embeds example JSON with `published: true` is still a source seed unless the **running host** loaded the same object from config authority the owner operates. Engineering may keep the refuse path; it may not treat git examples as live policy.

---

## What this unblocks / what stays blocked

**Unblocked for engineering:** keep refuse-closed doors honest; wire authority **reads**; name residuals; do not invent callers that assume a published rate.

**Still blocked:** any payout, commission, affiliate accrual, or PSP price that needs a magnitude. Those wait on owner publish into config authority.

**Out of this ADR:** PKT-B5 futures profit pot, PAYOUT-01 hop-depth click, D26-P0-10 commission _mechanism_ (authority + refuse-blank), D26-P0-15 geo list, Class X secrets, Vue, `svc-edge`.

---

## Forbidden invent paths

Agents must not:

- Fill `leaderShareBps`, affiliate hop `rate`s, `MARKET_HOUSE_COMMISSION_BPS`, or a pay fee table “so the suite is green.”
- Treat `.env.example` or compose defaults as owner publish.
- Dual-edit `svc-trade` / `svc-identity` / `svc-market` under this docs mountain.

---

## Internet leverage

Phase A: existing `svc-trade` copy refuse (`COPY_FEE_SHARE_RESIDUAL`) + ledger recipes when a rate _is_ later published. Horizon: `trade.copy` is **LAW→IN** — this file is the LAW slice (launch-closed). No second SPA, no second money book, no greenfield fee engine.
