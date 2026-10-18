# TRK-trade.forex — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `trade.forex`  
**Title:** Fiat pairs on the same engine  
**Module / phase:** `trade` · multi-asset  
**Status on tip:** `ready` · **owner:** none (product law — Denon directs multi-asset)  
**Tip freeze:** `origin/main` @ `56696496`  
**Pack type:** research only — **no invent FX prices**; fiat settlement Class-adjacent.

---

## 1 · What “done” means (plain language)

1. Fiat pairs list on the **same** matching/trade engine with honest market hours.
2. Weekend / closed venue orders **refuse** (`trade.market_closed`) — no funded hold.
3. Fiat **settlement rails** exist or markets stay unlistable — no pretend EUR balance.
4. Marks/prices from real sources or typed refusal — never fabricated mid.

---

## 2 · Current code state (tip)

### 2.1 Already true (instrument + hours)

From tracker note (verify on tip before implement):

| Capability                              | State                                     |
| --------------------------------------- | ----------------------------------------- |
| Instrument model                        | `asset_class` + schedule on trade markets |
| Venue hours on order-create             | `assertMarketOpen` before hold (#102 era) |
| Fail-safe unrecognised schedule         | Refuse, do not throw open                 |
| CME Globex break / Chicago DST coverage | Documented complete for hours path        |
| E2E closed venue                        | No hold, no intent row                    |

### 2.2 Still missing for titled product

| Gap                     | Reality                                                    |
| ----------------------- | ---------------------------------------------------------- |
| Fiat settlement rails   | **Not** product-complete — no production forex market list |
| Multi-asset product law | Denon direction — agents do not invent FX product law      |
| Human M3 futures risk   | Adjacent money risk board — babysit                        |

### 2.3 Services

- `services/svc-trade` owns markets/orders; README lists forex as separate from spot scope of early PRs.
- Venue fabric marks (`TRADE_VENUE_MARK_*`) never invent mid when empty.

---

## 3 · Doctrine constraints

| Law              | Implication                                     |
| ---------------- | ----------------------------------------------- |
| No invent prices | Empty book / closed market → refuse             |
| Money            | Fiat balances only via bank/pay rails + ledger  |
| Product law      | Denon directs multi-asset; agents research/spec |
| Shehzad          | Pay/bank rails may gate real fiat               |

---

## 4 · DoD sketch

- [ ] Settlement rail decision recorded (bank/pay)
- [ ] First fiat market listed with hours + refuse tests green in real env
- [ ] No UI showing invent FX conversion (shell CNY honesty already)

---

## 5 · Open questions

1. Which fiat pairs first (EUR/USD only)?
2. Bank M* dependency vs synthetic USD-margined only?
3. Wait for Denon multi-asset ADR?

---

## 6 · Estimated size

| Hours already largely done | residual **S** for listing once rails exist |
| Full fiat product | **L** + bank/pay |

---

## 7 · Related docs / code

- `services/svc-trade` market hours / schedules
- Tracker note on `trade.forex` in `features.mjs`
- Long-form twin: [TRK-trade.forex.md](./TRK-trade.forex.md)

---

## 8 · Explicit non-goals

- No inventing FX rates for decoration.
- No listing forex markets without settlement honesty.
- No agent-written product law superseding Denon.

---

## 9 · Shell honesty (do not regress)

Vendor shell historically used unguarded CNY conversion (`CNYRate || 6.5` removed). Forex product must not reintroduce decorative FX multipliers without a rate service.

## 10 · Relation to venue fabric

Venue mark path can supply external mids for some markets when configured — still **never invents**. Forex fiat pairs still need settlement rails before listing.

## 11 · First PR shape (after rails decision)

| PR  | Scope                                                    |
| --- | -------------------------------------------------------- |
| 1   | Settlement ADR (Denon/bank)                              |
| 2   | List one fiat market in non-prod with hours refuse tests |
| 3   | UI pair display without invent conversion                |

## 12 · One-line residual

Hours path largely done; fiat settlement rails + product law before any listed forex market.

## 13 · Freeze reminder

Re-derive tip and open PR path intersect before any trade market listing PR. Partner money PRs stay babysit-only.
