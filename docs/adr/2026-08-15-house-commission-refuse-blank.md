# ADR: house commission refuse-blank (D26-P0-10)

**Status:** **Accepted — 2026-08-15 (D26-P0-10 mechanism reaffirmed).**  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-10 — listings / treasury / house commission law.  
**Packet:** `OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md` (removed) §P0-10.  
**Prior seal:** [`2026-08-13-house-commission-authority.md`](2026-08-13-house-commission-authority.md) (#1790) — mechanism.  
**Overlaps:** D26-P0-02 owns the **number**. This ADR does **not** publish a bps figure.  
**Does not invent:** a marketplace cut, a free-commission `0`, a compose `:-0` seed, treasury splits, or a second fee book.  
**Does not edit:** `services/svc-market`, `packages/ledger-client`.

---

## The decision

> **Blank `MARKET_HOUSE_COMMISSION_BPS` (or a successor named authority) refuses. Silence is not a free house cut. `0` is lawful only when the owner publishes `0` on that authority (D26-P0-02). Agents must not invent free commission.**

This is settled. Engineering implements the refuse; it does not fill the blank.

---

## Why this document exists after #1790

Packet §P0-10 asked two questions: where authority lives, and whether blank refuses.

Tip already answers both in `market.commerce` (tracker row on main: blank `MARKET_HOUSE_COMMISSION_BPS` refuses `market.commission_not_configured`; never invents free commission; `0` only when the owner sets it). The first P0-10 ADR (#1790) sealed that mechanism.

A later paragraph on that ADR treated `.env.example` `MARKET_HOUSE_COMMISSION_BPS=0` as **this** mountain’s number click. That is P0-02 magnitude, not P0-10 law. P0-10’s done bar is authority + refuse-blank. Publishing `0` (or any other bps) is a different mountain. This ADR restores that split.

Same pattern as copy fee-share residual: unset is refuse-closed and named, not a source seed.

---

## What is sealed (P0-10)

1. **Authority.** House commission bps live only as owner-published `MARKET_HOUSE_COMMISSION_BPS` on a durable host (or a successor named env/authority the owner publishes). Not a JSON table in git. Not a `svc-market` constant.

2. **Blank refuses.** Missing / empty / unset → `market.commission_not_configured`. Create-listing and purchase already gate before slot burn and before ledger post. A catalogue that cannot settle must not consume stake.

3. **Zero is explicit.** `0` means the owner chose a free cut. Silence is not `0`. Agents must not write `0` to “unblock” commerce.

4. **Treasury path (already on tip).** House cut posts only through named ledger recipes (`marketPurchase` → `houseFees(market)`). `svc-market` holds no balance. Crash re-drive uses the claim snapshot, not a live env reread.

5. **Subscriptions.** `market.subscription_not_built` stays refuse. This ADR does not invent C3 period/past-due law.

---

## What remains P0-02 (not this row)

- The actual bps, including whether production ever takes a cut.
- Whether any host `.env` / example file carries a published `0`.
- Ranking / featured catalogue (DIRECTION §8).

Until P0-02 publishes a number (or an explicit launch-closed forever), commerce that needs a rate stays refuse-closed. `market.commerce` C1+C2 **done** means the **mechanism** is done, not that a rate exists.

---

## What agents must not do

- Invent a non-zero bps, a “sensible marketplace cut,” or a compose `${MARKET_HOUSE_COMMISSION_BPS:-0}` default.
- Treat example-file `0` as P0-10 authority to run free commission in production.
- Dual-edit `commerce-service.ts` / `env.ts` / `packages/ledger-client` because this ADR landed.
- Close P0-02 by writing a rate into this mountain.

---

## Proof on tip (cite only — this ADR does not dual-edit market)

- Tracker `market.commerce` — blank `MARKET_HOUSE_COMMISSION_BPS` refuses `market.commission_not_configured`; `0` only when owner sets.
- `services/svc-market/src/env.ts` — no in-code default.
- `services/svc-market/src/commerce/commerce-service.ts` — `requireCommissionConfigured`.
- Compose pass-through `${MARKET_HOUSE_COMMISSION_BPS:-}` (empty default, not `:-0`).
