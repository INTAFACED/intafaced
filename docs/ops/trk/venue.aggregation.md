# TRK-venue.aggregation — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `venue.aggregation`  
**Title (tracker):** External venue adapters via CCXT (cross-venue) — **name is stale**  
**Module / phase:** `trade` · phase 2 · plane **F**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `trade.spot` (**done**)  
**Requires:** `packages/venue-adapter`, `packages/venue-contracts`  
**Tip freeze:** `origin/main` @ `c7af0849` (re-derive before implement)  
**Pack type:** research only. Futures risk truth remains **human M3** — do not invent under this id.

---

## 1 · What “done” means (plain language)

1. Cross-venue **market data** and (later) **trading** talk **our adapter fabric** — not a third-party connectivity library in the money path.
2. **§27 / Doctrine 5:** no `ccxt` in workspace **by design**; we are the CCXT-class layer (typed, streaming-first, latency-graded, ledger-aware).
3. At least a **second venue** has a real `MarketDataAdapter` + factory id — **met 2026-08-08**: `bybit-spot`, public MD only. Was `binance-spot` alone.
4. Trading half either works with credentials + rails **or** throws typed `not_ready` — never silent no-op success.
5. Marks **never invent mid** when venue/book missing (empty venue, unknown id, unmapped market, empty book → null).
6. Venue Vault for credentials exists before live trading half is claimed done.

**Honesty rename (mountain event when shipping):** drop “via CCXT” from tracker title — law is first-party fabric.

---

## 2 · Current code state (tip)

### 2.1 Contracts package (done substrate)

`packages/venue-contracts` — types only; no transport; no venue names:

| File                                             | Role                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `adapter.ts`                                     | `MarketDataAdapter` — `snapshotBook` once + stream; **no pollBook** |
| `decimal.ts`                                     | Refuses JSON number at wire (anti-CCXT float)                       |
| `errors.ts`                                      | Typed exclusions including `not_ready`                              |
| `book.ts`, `market.ts`, `account.ts`, `rates.ts` | Unified schema                                                      |
| `index.ts`                                       | Documents why CCXT is absent                                        |

Value never moves here (§0.6); account types are **observations** of third-party records.

### 2.2 Adapter fabric (partial)

`packages/venue-adapter`:

| Area                               | Path                                                       | Status                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Binance spot public MD             | `src/fabric/venues/binance-spot.ts`                        | **Done** — `BinanceSpotMarketData` implements MD                                                                            |
| Bybit spot public MD               | `src/fabric/venues/bybit-spot.ts`                          | **Done** — `BybitSpotMarketData` implements MD; public only, **no trade/account classes exist for it at all**               |
| Trading / account methods          | `binance-spot.ts` only                                     | **Throw** `VenueUnavailableError(..., 'not_ready', ...)` for place/cancel/fetch/openOrders/balances/positions/transferRails |
| Book feed                          | `src/fabric/book-feed.ts`                                  | Streams over adapter                                                                                                        |
| Sequenced book                     | `src/fabric/sequenced-book.ts`                             | Gap-aware book tracker                                                                                                      |
| Rate limit / latency / cross-check | `src/fabric/rate-limit.ts`, `latency.ts`, `cross-check.ts` | Fabric machinery                                                                                                            |
| Factory surface                    | re-exported via fabric index                               | **Two** venue ids wired                                                                                                     |

### 2.3 svc-trade mount (partial — marks only)

| Piece           | Path                                                 | Behavior                                                                                           |
| --------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Adapter factory | `services/svc-trade/src/futures/mark-from-venue.ts`  | `createVenueMarketDataAdapter` — `binance-spot`, `bybit-spot`; unknown / near-miss id → null       |
| Env             | `services/svc-trade/src/env.ts`                      | `TRADE_VENUE_MARK_VENUE`, `TRADE_VENUE_MARK_SYMBOLS`, `TRADE_MM_SEED_MID_FROM_VENUE` (default OFF) |
| Boot            | `services/svc-trade/src/index.ts`                    | Builds public adapter; warns if unknown id; never invents                                          |
| MM mid          | `services/svc-trade/src/mm/mid-source.ts`            | Optional venue mid after env map miss                                                              |
| Ops docs        | `services/svc-trade/README.md` § “Venue fabric mark” | Enable path A-TRADE-VENUE-1 / OPS                                                                  |

**Default:** venue mark **OFF** (empty venue id). When on: public book mid preferred for futures marks; still null on miss.

### 2.4 Still not built (tracker note 2026-08-02)

1. ~~Only **one** public venue — second needs real adapter + factory id.~~ **CLOSED 2026-08-08** — `bybit-spot` public MD, registered in `createVenueMarketDataAdapter` and reached by id from the ops factory. Four residuals remain, so the row is still not `done`.
2. **Trading half** not built (credentials construct; ops throw `not_ready`). Untouched — `bybit-spot` deliberately has no trade/account half to be honest about.
3. **Venue Vault** absent (credential custody). Untouched, and not required for public MD.
4. No live-network CI for trading — nor for public MD. `bybit-spot` is tested against fixtures only; nothing in CI reaches the venue.
5. Futures **risk truth** remains human **M3** — not this mountain.

---

## 3 · Doctrine constraints

| Law                   | Implication                                            |
| --------------------- | ------------------------------------------------------ |
| §27 INTAFACED CONNECT | Own CCXT-class layer; no third-party lib in money path |
| Money decimal         | Amount types refuse JSON numbers                       |
| Streaming books       | Sequence/gap checks; no silent age                     |
| Fail closed           | Venue down/stale/rate-limited → exclude and report     |
| §0.6                  | Adapters do not hold platform balances                 |
| Class M               | Trading half + transfers = external money — high bar   |
| Shehzad M3            | Futures risk product law — babysit / do not invent     |
| Never invent mid      | Null over fake mid                                     |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — second public MD venue (smallest free craft) — **DONE 2026-08-08**

- [x] New `MarketDataAdapter` implementation — `BybitSpotMarketData` (`packages/venue-adapter/src/fabric/venues/bybit-spot.ts`). Chosen because everything on its wire is a decimal string (REST **and** WS) and both its REST book and its stream carry an update id, so the existing `SequencedBookTracker` / `MaintainedBook` drive it unchanged. No venue SDK, no `ccxt`.
- [x] `createVenueMarketDataAdapter` knows the id — `bybit-spot`; near-miss ids (`bybit`, `bybit-futures`) still refuse.
- [x] Symbol map tests; empty book → null mid — plus one-sided, unknown venue symbol, unmapped market, malformed payload, rate-limited and unreachable, each asserted `null` on the money path through the real adapter.
- [x] No trading, no Vault — no `BybitSpotTrade`/`BybitSpotAccount` exist; no credential is read, held or named.
- [ ] Optional: tracker title rename mountain event (drop CCXT).

### Stage 2 — MD production hardness

- [ ] Live-network optional CI for public MD (flake budget deliberate).
- [ ] Cross-check / latency grading used in ops health.
- [ ] Multi-symbol rate-limit proven under load test.

### Stage 3 — trading half (Class M + Vault)

- [ ] Credential custody design (Venue Vault) approved.
- [ ] place/cancel/fetch implemented with rails + ledger awareness where required.
- [ ] Typed errors only; no silent drop.
- [ ] Failure tests: bad keys, partial fills, disconnect mid-order.

### Stage 4 — aggregation product

- [ ] Cross-venue consolidated views use fabric (existing `consolidated-book` / cross-check) with exclusion honesty.
- [ ] Never present excluded venue as consensus.

**Tracker `done`:** product decides whether Stage 1 (multi-venue MD) or Stage 3 (trading) is title-complete. Current title “adapters via CCXT” is wrong; prefer rename + Stage 1+.

---

## 5 · Gaps

1. ~~Second+ venue MD adapters.~~ Second done (`bybit-spot`); a THIRD is not required by any residual.
2. Entire trading half.
3. Venue Vault.
4. Live-network CI policy.
5. Stale tracker title.
6. M3 futures risk outside this id.

---

## 6 · Risks

| Risk                                   | Mitigation                             |
| -------------------------------------- | -------------------------------------- |
| Add `ccxt` dependency                  | Forbidden §27 — reject                 |
| Invent mid on outage                   | Keep null path; tests                  |
| Trading without Vault                  | Class X/M custody fail                 |
| Stub second venue name without adapter | Factory must refuse unknown            |
| Touch M3 risk under aggregation        | Human-owned — out of scope             |
| Flaky live CI blocks merge forever     | Optional public MD CI; trading careful |

---

## 7 · Estimated size

| Slice                  | Size                  | Notes                   |
| ---------------------- | --------------------- | ----------------------- |
| Title rename honesty   | **XS** mountain event | Class N                 |
| Second public MD venue | **S**                 | Free craft when claimed |
| MD CI + ops polish     | **S–M**               |                         |
| Vault design           | **M**                 | Product/ops + Class X   |
| Trading half one venue | **L** Class M         | Separate PR program     |
| Full multi-venue trade | **XL**                |                         |

**First PR size (if free):** **S** — second public MD venue only: real `MarketDataAdapter` + factory id + symbol map tests; no trading, no Vault. Or **S** — honesty rename of tracker title via mountain event. Trading half = separate Class M after Vault decision.

---

## 8 · Related docs / code

- Tracker note `venue.aggregation` in `tooling/tracker/features.mjs` (A-TRADE-VENUE-OPS)
- `packages/venue-contracts/**`
- `packages/venue-adapter/src/fabric/**`
- `services/svc-trade/src/futures/mark-from-venue.ts`
- `services/svc-trade/src/mm/mid-source.ts`
- `services/svc-trade/README.md` — Venue fabric mark
- Doctrine §27
- Human M3 — futures risk (do not invent)

---

## 9 · Explicit non-goals

- No adding npm `ccxt`.
- No inventing mid prices.
- No futures risk engine under this id (M3).
- No OTC product law.
- No R07/R01 stamp content.
- No claiming trading half done while methods throw `not_ready`.
