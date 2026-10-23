# TRK-trade.ccxt-api — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `trade.ccxt-api`  
**Title:** CCXT-compatible public API (bots + terminals connect)  
**Module / phase:** `trade`  
**Status on tip:** `ready` · **owner:** none  
**Pack type:** research + residual implement notes — **compatibility surface**, not embedding `ccxt` library in money path.

---

## 1 · What “done” means (plain language)

1. External bots/terminals can speak a **CCXT-shaped** public REST/ws surface.
2. Platform remains the connectivity layer (§27) — **no** `ccxt` package in the money path.
3. Prices/balances from platform services — never float-normalized invent.
4. Auth, rate limits, and market metadata honest when empty.
5. A bot can tell **paper vs real**, **listing active vs session open**, and **unsupported capability vs broken deploy**.

---

## 2 · Current code state (tip)

### 2.1 What is not this row

| Confusion                    | Truth                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| “via CCXT” venue aggregation | **Stale title language** — §27 forbids third-party connectivity lib in money path; no `ccxt` in workspace by design |
| Venue fabric                 | `packages/venue-contracts` + `venue-adapter` (Binance spot **public** MD only; trading half not_ready)              |
| DEX quote router             | Separate row `dex.quote-router` — refuse-or-real                                                                    |

### 2.2 Mounted surface (contract-complete routes)

All `REST_ROUTES` in `@intafaced/exchange-contract` are mounted on `svc-trade`.

| Gap (stale note)                        | Reality on tip                                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| setLeverage / setMarginMode not mounted | **Mounted** as 501 `NotSupported` (`trade.leverage_unsupported` / `trade.margin_mode_unsupported`) — never silent 200                     |
| OHLCV empty without candle job          | REST aggregates **live** non-seeded taker fills (`queryCandlesFromFills`). Honest `[]` when never traded. Materialize job default **OFF** |
| futures jobs default OFF                | **By design** — fail-closed; ops enable `TRADE_FUTURES_JOBS_*` deliberately                                                               |
| exitPrice required on close             | **Inverted** — caller price fields refused 400; mark path only                                                                            |
| Paper markets invisible                 | `paper` on market wire (#1112)                                                                                                            |
| Hours invisible                         | `schedule` + `sessionOpen` + `hours` + `nextSessionChange` on market wire (same table as `assertMarketOpen`)                              |

### 2.3 Residual still real

| Residual                               | Notes                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Empty books until seed / first order   | Matching journals markets from activity; MM seed is `trade.mm-bot` (default OFF). Empty book is honest depth, not 502 |
| Paper still listed publicly            | Flagged; whether to **exclude** from public list is Nitro product call (N3)                                           |
| FX pairs listed + unfundable           | Not de-listed here — settlement law is owner (D-S-05). Do **not** invent forex production rails                       |
| Live re-leverage                       | Still not built — 501 is correct until re-margin product law exists                                                   |
| Rate limit numbers on contract vs edge | Published `RATE_LIMITS` vs edge 300/min — Nitro N4                                                                    |
| Private WS                             | Under `ws.gateway`, not this REST surface                                                                             |

---

## 3 · Doctrine constraints

| Law           | Implication                                                    |
| ------------- | -------------------------------------------------------------- |
| §27           | No ccxt import on money path; parseLevels refuses JSON numbers |
| Compatibility | “CCXT-compatible” = wire shape, not dependency                 |
| P-WS          | Depth/stream integrity before promising bot WS parity          |
| No invent     | Empty markets → empty structures; closed session → not “down”  |

---

## 4 · DoD sketch

- [x] REST route map mounted (public + private)
- [x] Honest empty structures (depth, OHLCV, positions)
- [x] Unsupported capabilities as 501 NotSupported (not generic 404)
- [x] Paper flag on markets
- [x] Session hours on markets
- [ ] Published OpenAPI of CCXT-like endpoints mapped to monorepo
- [ ] Auth model + rate limits aligned (edge vs published)
- [ ] Conformance tests against subset bots use
- [ ] Explicit non-support list (document for integrators)

---

## 5 · Open questions

1. REST-only v1 vs WS required for title? (Private WS = `ws.gateway`)
2. Which CCXT version surface year to target?
3. Exclude paper markets from public `fetchMarkets` entirely? (Nitro)

---

## 6 · Estimated size

| Remaining honesty residuals | **S–M** |
| Full bot parity + WS | **XL** |

---

## 7 · Related docs / code

- `services/svc-trade/src/public-rest.ts` — markets, book, ticker, trades, ohlcv, funding-rate
- `services/svc-trade/src/private-rest.ts` — orders, balance, fees, positions, leverage/margin 501
- `services/svc-trade/README.md` venue fabric + candle ops
- `packages/venue-adapter` public MD only
- Harvest residual map: `docs/TRADE-LANE-HARVEST-2026-08-08.md` §2.8 / §4 / §6

---

## 8 · Explicit non-goals

- No adding `ccxt` dependency.
- No invent marks / candles / mids for bot happiness.
- No invent forex settlement or production FX rails.
- No live re-leverage without product law.

---

## 9 · Mapping sketch

| CCXT-ish surface | Platform owner                               |
| ---------------- | -------------------------------------------- |
| fetchMarkets     | trade markets list via public REST           |
| fetchOrderBook   | matching depth — empty when never journalled |
| fetchOHLCV       | live fill aggregation (non-seeded)           |
| createOrder      | trade order path + holds                     |
| fetchBalance     | ledger-backed account APIs                   |
| setLeverage      | 501 NotSupported (set at open)               |

Each mapping must preserve decimal strings and refuse invent zeros.

## 10 · One-line residual

Contract routes mounted and fail-closed; remaining bot leverage is empty-book seed ops (`trade.mm-bot`), paper-list policy, and rate-limit honesty — not missing leverage endpoints or candle REST.
