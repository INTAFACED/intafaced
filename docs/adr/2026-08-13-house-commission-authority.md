# ADR: house commission authority — blank refuses, numbers stay owner

**Status:** **Accepted — 2026-08-13 (D26-P0-10 sealed).**  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-10 — listings / treasury / house commission law.  
**Packet:** `OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md` (removed) §P0-10.  
**Overlaps:** D26-P0-02 (the **number**); this ADR is the **mechanism**.  
**Does not invent:** a bps figure, a “launch 50 bps” seed, treasury splits, or a second fee book.

---

## The decision (one sentence)

> **House marketplace commission lives only as owner-published `MARKET_HOUSE_COMMISSION_BPS` on a durable host. There is no in-repo default. Unset is `market.commission_not_configured`, not free commerce. Explicit `0` is an owner decision to take no cut. Agents do not write a rate. Closing P0-02 is publishing the number, not this ADR.**

This is settled. The doors already refuse. The rate is not.

---

## Why this is the ruling, not a number

Packet §P0-10 asked: where does authority live, and does blank refuse? Tip already answers both in `svc-market`: optional env, refuse before listing insert and before purchase, settlement via `recipes.marketPurchase` → `houseFees(market)`.

Writing `50` (or any “sensible marketplace cut”) into source would freeze an invented DIRECTION §8 rate as policy. Same crime as copy `leader_share_bps`.

P0-10’s done bar is **authority + refuse-blank**. That is this document plus the shipped gate. The bps value remains P0-02 / Nitro env.

---

## What is sealed

1. **Authority.** `MARKET_HOUSE_COMMISSION_BPS` on the host. Integer bps 0..9999. Not a JSON table in git. Not a `svc-market` constant.

2. **Blank refuses.** Missing / empty env → `market.commission_not_configured`. Create-listing and purchase both gate **before** slot burn and **before** ledger post. A catalogue that cannot settle must not consume stake.

3. **Zero is explicit.** Owner-set `0` is free commission. Silence is not zero.

4. **Treasury path.** House cut posts only through named ledger recipes (`marketPurchase` → `houseFees(market)`). `svc-market` holds no balance. Crash re-drive uses the claim snapshot, not a live env reread that could change the cut after the user clicked.

5. **Subscriptions.** `market.subscription_not_built` stays refuse. This ADR does not invent C3 period/past-due law.

---

## What remains owner-open (P0-02 / Nitro)

- The actual bps (or launch-closed forever).
- Ranking / featured catalogue (DIRECTION §8).
- C3 subscription economics.

Until a number is published, commerce stays refuse-closed. `market.commerce` C1+C2 staying `done` means the **mechanism** is done, not that a rate exists.

**Number click (2026-08-13):** owner published `MARKET_HOUSE_COMMISSION_BPS=0` in `.env.example` (explicit free-cut). Compose remains pass-through with no default. Unset on a host is still `market.commission_not_configured`.

---

## What agents must not do

- Seed a non-zero `MARKET_HOUSE_COMMISSION_BPS` or a compose `${...:-0}` default. The owner number is `.env.example` `0` (2026-08-13); silence on a host is still refuse.
- Dual-edit `commerce-service.ts` / `env.ts` because this ADR landed.
- Treat `0` as the default to “unblock” screens.

---

## Proof on tip (already; this ADR does not dual-edit market)

- `services/svc-market/src/env.ts` — no default
- `services/svc-market/src/commerce/commerce-service.ts` — `requireCommissionConfigured`
- Refuse code `market.commission_not_configured`
- Tracker: `market.commerce`
