# ADR: D26-P0-02 owner launch seals — fee-shares, profit pot, payout click

**Status:** **Accepted — 2026-08-13 (D26-P0-02 + PKT-B5 + PAYOUT-01 sealed).**  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-02 — DIRECTION §8 rates / fee-shares.  
**Packet:** `OWNER-DECISION-PACKET-2026-08-09.md` (removed) §3; index `docs/ops/owner-ruling-packet.json` (removed).  
**Consent:** owner session 2026-08-13 — these numbers are host law, set on the host (see the private records).  
**Does not invent:** live PSP credentials, sanctions / jurisdiction lists, prod RPC, token emission magnitudes, DEX venue names, marketplace bps, insurance fund size, D3 ladder, Class X secrets.

---

## The decision (one sentence)

> **Copy leaders take an owner-set share of our protocol trading fee (not of notional, not of P&L), capped per follower per period and decaying after an owner-set number of round-trips. Affiliates take owner-set shares of the same fee at the published hops (`MAX_PAYOUT_TIER_DEPTH` stays 5). Realised futures profit is paid from `house:fees:trade:available`. Marketplace commission and pay fee tables are owner-set host values. Copy jurisdictions owner-published 2026-08-14 in `.env.example` (D26-P0-15). Funding stays off until a listed market is explicitly enabled.**

The figures and the reasons for them are set by the owner; see the private records. They are not in this public repo (git history keeps an older copy).

This is settled. Agents implement against it. They do not re-litigate the percentages in callers.

---

## Units

Units already exist in code. Copy `leaderShareBps` is bps **of the house trading fee**. Affiliate `rate` is a decimal **share of that fee**. Hops the owner leaves unpublished take nothing, so the remainder stays in `houseFees`.

`house:fees:trade:available` is the only account `recipes.futuresRealizeProfit` draws from. Naming any other pot fails boot. CX8 already used this spelling; this ADR is the owner choosing that pot for deploy, not a second book.

Marketplace `MARKET_HOUSE_COMMISSION_BPS` has no in-repo value (P0-10 authority). Silence is not `0`. Pay PSP tables stay unset (Class X). Copy geo is owner-published in `.env.example` (2026-08-14); compose still has no default.

---

## What is sealed

### 1. Copy fee-share — `TRADE_COPY_FEE_SHARE_LAW`

Shape (figures set by the owner on the host; see the private records):

```json
{
  "published": true,
  "leaderShareBps": "<int>",
  "earningsCapPerFollower": "<decimal>",
  "decayRoundTrips": "<int>",
  "decayShareBps": "<int>"
}
```

Follow is live where `TRADE_COPY_JURISDICTION_LAW` is published (`.env.example` 2026-08-14). Blank host still refuse-closed.

### 2. Affiliate accrual — `IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON`

Shape (rates set by the owner on the host; see the private records):

```json
{
  "published": true,
  "tiers": [{ "hop": 0, "rate": "<decimal 0..1>" }]
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

- `MARKET_HOUSE_COMMISSION_BPS` — owner-set on the host (see the private records). Compose still has no default. Unset on a host still refuses.
- Pay fee / PSP bps — Class X.
- `TRADE_COPY_JURISDICTION_LAW` — owner-published 2026-08-14 in `.env.example` (not worldwide; blank host still refuse).
- Token emission / buyback / burn / staking magnitudes.
- DEX venues, insurance target size, D3 rungs, N3 paper-exclude.

---

## What agents must not do

- Change these percentages in `svc-trade` / `svc-identity` callers to “unblock” a tracker row.
- Seed any `MARKET_HOUSE_COMMISSION_BPS` value in the repo, or a compose `:-0` default. The number is the owner's, set on the host.
- Treat unpublished copy jurisdictions as “worldwide”.
- Capitalise the profit pot from treasury or invent an insurance fund.

---

## Proof this PR must carry

- `.env.example` documents each key's shape and leaves the owner's figures blank (public-repo hygiene, 2026-11-07)
- compose pass-through for the two JSON vars (identity + trade)
- boot-config: shipped profit source parses; empty still refused by the strict constructor
- parsers accept the published JSON (copy + affiliate pin tests)
