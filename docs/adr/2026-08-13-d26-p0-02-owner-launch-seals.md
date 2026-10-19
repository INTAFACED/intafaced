# ADR: D26-P0-02 owner launch seals — fee-shares, profit pot, payout click

**Status:** **Accepted — 2026-08-13 (D26-P0-02 + PKT-B5 + PAYOUT-01 sealed).**  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-02 — DIRECTION §8 rates / fee-shares.  
**Packet:** `OWNER-DECISION-PACKET-2026-08-09.md` (removed) §3; index `docs/ops/owner-ruling-packet.json`.  
**Consent:** Denon session 2026-08-13 — publish these numbers as host law.  
**Does not invent:** live PSP credentials, sanctions / jurisdiction lists, prod RPC, token emission magnitudes, DEX venue names, marketplace bps, insurance fund size, D3 ladder, Class X secrets.

---

## The decision (one sentence)

> **Copy leaders take 1000 bps of our protocol trading fee (not of notional, not of P&L), capped at `1000.00` per follower per period, decaying to 5000 bps of that share after 50 round-trips. Affiliates take 10/5/2 percent of the same fee at hops 0/1/2 (`MAX_PAYOUT_TIER_DEPTH` stays 5). Realised futures profit is paid from `house:fees:trade:available`. Marketplace commission and pay fee tables stay unpublished. Copy jurisdictions owner-published 2026-08-14 in `.env.example` (D26-P0-15). Funding stays off until a listed market is explicitly enabled.**

This is settled. Agents implement against it. They do not re-litigate the percentages in callers.

---

## Why these numbers

Units already exist in code. Copy `leaderShareBps` is bps **of the house trading fee**. Affiliate `rate` is a decimal **share of that fee**. Together hops 0–2 take 17% of the fee pot; hops 3–4 stay unpublished so the remaining 83% stays in `houseFees`.

`house:fees:trade:available` is the only account `recipes.futuresRealizeProfit` draws from. Naming any other pot fails boot. CX8 already used this spelling; this ADR is the owner choosing that pot for deploy, not a second book.

Marketplace `MARKET_HOUSE_COMMISSION_BPS` stays **blank** (P0-10 authority). Silence is not `0`. Pay PSP tables stay unset (Class X). Copy geo is owner-published in `.env.example` (2026-08-14); compose still has no default.

---

## What is sealed

### 1. Copy fee-share — `TRADE_COPY_FEE_SHARE_LAW`

```json
{
  "published": true,
  "leaderShareBps": 1000,
  "earningsCapPerFollower": "1000.00",
  "decayRoundTrips": 50,
  "decayShareBps": 5000
}
```

Follow is live where `TRADE_COPY_JURISDICTION_LAW` is published (`.env.example` 2026-08-14). Blank host still refuse-closed.

### 2. Affiliate accrual — `IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON`

```json
{
  "published": true,
  "tiers": [
    { "hop": 0, "rate": "0.10" },
    { "hop": 1, "rate": "0.05" },
    { "hop": 2, "rate": "0.02" }
  ]
}
```

Durable accrue uses this env only. Per-call invent still refuses. `svc-pay` caller is not this ADR.

### 3. Futures profit pot — `TRADE_FUTURES_PROFIT_SOURCE` (PKT-B5)

`house:fees:trade:available`

Published in `.env.example`. Compose still passes `${TRADE_FUTURES_PROFIT_SOURCE:-}` with **no** compose default. A host that copies the example gets the named pot; a host that blanks it still boots with futures profit refused.

`TRADE_FUTURES_ENABLED` stays `false`. Funding stays off (PKT-B6): no invented `TRADE_FUTURES_FUNDING_MAX_ABS_RATE`, no market id list.

### 4. PAYOUT-01 clicked

| Decision                 | Click                                                           |
| ------------------------ | --------------------------------------------------------------- |
| `MAX_PAYOUT_TIER_DEPTH`  | **5**                                                           |
| Fee pool                 | named `"identity"` + per-event `sourceModule` (`trade` / `pay`) |
| Atomicity                | replay-safe by business key                                     |
| Multi-beneficiary recipe | do not invent                                                   |

### 5. Still unpublished (launch-closed)

- `MARKET_HOUSE_COMMISSION_BPS` — **owner published `0`** (2026-08-13 explicit free-cut in `.env.example`). Compose still has no default. Unset on a host still refuses.
- Pay fee / PSP bps — Class X.
- `TRADE_COPY_JURISDICTION_LAW` — owner-published 2026-08-14 in `.env.example` (not worldwide; blank host still refuse).
- Token emission / buyback / burn / staking magnitudes.
- DEX venues, insurance target size, D3 rungs, N3 paper-exclude.

---

## What agents must not do

- Change these percentages in `svc-trade` / `svc-identity` callers to “unblock” a tracker row.
- Seed a **non-zero** `MARKET_HOUSE_COMMISSION_BPS` or a compose `:-0` default. Owner published `0` in `.env.example` (2026-08-13); that is the number click, not a silent compose seed.
- Treat unpublished copy jurisdictions as “worldwide”.
- Capitalise the profit pot from treasury or invent an insurance fund.

---

## Proof this PR must carry

- `.env.example` uncommented values matching the JSON above
- compose pass-through for the two JSON vars (identity + trade)
- boot-config: shipped profit source parses; empty still refused by the strict constructor
- parsers accept the published JSON (copy + affiliate pin tests)
