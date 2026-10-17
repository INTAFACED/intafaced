# TRADE lane harvest — all seven mountains, read against tip

**Date:** 2026-08-08 · **Tip when read:** `origin/main` @ `8519bea5` (some sections re-verified at `229bab67`)
**Method:** seven independent read-only agents, one per mountain, each reporting the Done bar quoted from its own law, what is reachable on tip, and every number it would have to invent. Findings below were re-read by the lead agent before any of them were acted on.

---

## 0 · The correction that changes everything downstream

**Every `trade.*` mountain in the brief was described as unbuilt. Six of the seven are substantially built and merged.**

The brief was written against a working checkout that was **320 commits behind** `origin/main`. In that tree `services/svc-trade` has 78 TypeScript files; on tip it has 123. The tree had 5 ADRs; tip has 25. Three of the five law documents the brief cited by path — the futures risk/mark law, the exit-when-dark law, and the algo execution law — **do not exist in the stale tree at all** and are all present on tip.

Consequence: the lane's real work is not "build seven mountains." It is **finish, mount, and repair** what is already there. Two of the biggest items below are code that exists, passes its tests, and is _not reachable from any route_.

**Standing lesson:** re-derive tip before believing anything about this repo's state, including a brief.

`claim-check` reports **clear** on `services/svc-trade`. The "three human owners" record cited on some boards is stale.

---

## 1 · The scoreboard

| #   | Mountain         | True state on tip                                      | What actually blocks it                                              |
| --- | ---------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| T1  | `trade.futures`  | Built and hardened; **two of the three Done bars met** | Margin call and partial liquidation absent; six owner numbers        |
| T2  | `trade.otc`      | **Built and merged** (#1000), fully mounted            | Owner desk law; two money bugs (**both fixed, PR #1097**)            |
| T3  | `trade.copy`     | Built — and **entirely dead code**, nothing imports it | Not mounted; four money bugs; owner rates                            |
| T4  | `trade.algo`     | ~90% built; **the scheduler is dead code**             | `tickAllAlgos()` has zero callers; a restart bug must be fixed first |
| T5  | `trade.options`  | Instrument enum only                                   | **Settlement fixing** — genuinely an owner decision                  |
| T6  | `trade.ccxt-api` | **Contract-complete** — all 19 routes mounted          | Paper markets indistinguishable from real ones                       |
| T7  | `trade.forex`    | Hours engine done and well tested                      | **Six FX pairs are already listed and unfundable**                   |

---

## 2 · Money defects found

Ranked by how badly they end for a trader. Every one was confirmed by reading the code, not inferred.

### 2.1 FIXED — the OTC desk let the customer name the price (PR #1097)

`otc.quote` took `midPrice` as a **required wire input** under `trade:read`. Validated for shape only, multiplied into the quoted notional, bound on accept, settled through `marketMakerMakerFill` — which moves **house market-maker inventory**.

A caller past the stake gate could quote 10 BTC at a mid of `1`, accept their own quote at their own price, and take the inventory. Contained today only by the refuse-closed default; live the day the owner publishes a spread.

The module's comment said _"Mid must be caller-supplied — never invented."_ That is where the reasoning went wrong: a desk that prices at a number the taker chose has not avoided inventing a price, it has outsourced the invention to the one party with a reason to get it wrong.

### 2.2 FIXED — OTC settle re-posted a hold on every retry (PR #1097)

`settle()` minted `randomUUID()` for all three ledger ids per call, while posting three transactions in sequence and clearing the bound fill only after all three. A throw after the taker hold left the fill in place; the retry computed fresh keys, so the ledger saw a new transaction and posted a **second hold** — with no release path anywhere in the module.

### 2.3 FIXED — the third funding double-charge (PR #1098)

This file has shipped two already (#1034, #1047). The third was created by the assumption #1047's fix rested on: _"the ledger correctly dedupes, no money moves twice"_ — true only if the replayed legs carry the same keys.

The funding id ended in `:${seq}`, a counter running across the nested payer×payee loop. A replay whose book changed — one short closing, a plain `DELETE /api/v1/positions/:id` — renumbered every downstream leg, so surviving pairs reached the ledger under keys it had never seen and posted twice. Meanwhile the margin applier is idempotent and correctly did nothing, leaving `margin_current` recording one charge against a ledger that took two. That is the **inverse of #1034**, reached through the gap #1047 left open.

`seq` was never needed: each pair is emitted at most once per plan.

**Why five funding tests missed it twice:** every one replays a fixed array. None replays against a _changed_ book. The new test does, and was proven to fail against the old key before being trusted.

### 2.4 OPEN — copy trading's exposure counter only ever goes up

`copy-service.ts:185` does `setExposure(current + plan.notional)` for **both buy and sell**. Nothing ever decrements it. A follower who opens and closes ten times is permanently locked out by `maxAggregateExposure` while holding nothing.

The same non-transactional read-modify-write also affects the earnings cap: two concurrent fills both read the old total, both pass the cap, both pay. The cap is the churn brake the spec designs around.

Not exploitable today — the module is unreachable (§2.7).

### 2.5 OPEN — copy trading has no mirror idempotency key

`LeaderFillObservation` carries no fill id and no engine sequence. Every other money path in this service keys on a business id (`fillIdFor(marketId, sequence)`). A redelivered leader fill means the follower copies twice.

### 2.6 OPEN — mounting the TWAP scheduler would destroy every in-flight order

`algoPrincipals` is an **in-memory Map** populated only inside `createTwap`. `tickAllAlgos` rehydrates parents from Postgres but cannot rehydrate the principal, so after any restart every slice refuses, the engine records it as a miss and **advances the schedule**.

Net: the moment the scheduler is mounted, every algo surviving a deploy burns its whole remaining schedule to misses and ends `status: 'completed'` having placed nothing. Technically honest; a terrible outcome, and "completed" is the wrong word for it.

**This must be fixed in the same change as the scheduler, or mounting it is worse than leaving it dead.**

### 2.7 OPEN — the entire copy module is unreachable

Six source files, four test files, a migration, thirty passing tests — and **nothing outside `services/svc-trade/src/copy/` imports any of it**. Not in `router.ts`, `index.ts`, `private-rest.ts`, `events.ts`, `env.ts`, or `db/schema.ts`. The env vars that would publish its law (`TRADE_COPY_FEE_SHARE_LAW`, `TRADE_COPY_JURISDICTION_LAW`) exist **only inside their own error strings**, so even handed the numbers there is no way to load them.

Thirty green tests are currently protecting nothing.

### 2.8 OPEN — a CCXT bot cannot tell a paper market from a real one

`Market.paper` exists and is loaded, `trade.markets()` selects every row with no filter, and `presentCcxtMarket` never emits the flag. A paper market appears in `fetchMarkets` as an ordinary `active: true` spot market; `placeOrder` then silently routes it to the paper path — zero hold, no ledger post — and returns a 201 with an ordinary-looking order.

A bot books a position that does not exist. Same class as the empty-orderbook 502 that #185 fixed, and neither the tracker note nor the TRK doc mentions it.

**Whether paper markets belong in the public listing at all is a product call, not an engineering one.**

### 2.9 OPEN — six forex pairs are listed and unfundable

Migration `0001_multi_asset_instruments.sql:152-157` inserts EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CHF, USD/CAD as `status='active'`, and the public market list publishes them with `active: true` — its own comment calls them "live listings".

Meanwhile the only inbound fiat credit path is an `admin:treasury`-gated operator credit against a whitelisted rail, and the only registered rails are `crypto-native` and `card-sandbox`. **No live rail settles fiat.** Nothing fabricates money — but a bot is told EUR/USD is tradable.

The tracker note says _"no forex market is listed in production."_ Against the code that is **wrong**; the honest wording is _no forex market is **fundable**_.

---

## 3 · What is genuinely blocked on a human

Nothing below can be resolved by an agent without inventing product law.

### Denon — product law

| #   | Decision                                                                                                                                                                                                 | What it blocks                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| D1  | **Maintenance margin ladder.** `DIRECTION:32` requires it reference actual depth and explicitly **forbids a constant**. Tip ships a hardcoded 50% that nothing overrides — so tip already violates this. | Futures liquidation correctness                |
| D2  | **Funding rate cap.** Nothing bounds a published rate in law or code; `"1000"` is currently a valid period rate. The single largest unbounded money lever on tip.                                        | Futures funding safety                         |
| D3  | **Liquidation ladder parameters** — margin-call threshold, grace, tranche size, penalty. The ADR adopts svc-bank's _shape_, never its numbers.                                                           | Margin call + partial liquidation, both absent |
| D4  | **Insurance fund** — target size and funding share. `DIRECTION:33` says if it is empty, futures do not list; there is no such gate.                                                                      | Futures listing                                |
| D5  | **ADL** thresholds, ranking, and the pre-open disclosure `DIRECTION:34` mandates.                                                                                                                        | Futures endgame                                |
| D6  | **Dark-feed horizon** — how long a position may stay `closing` before something else happens.                                                                                                            | Exit-when-dark completeness                    |
| D7  | **Options settlement fixing** — which price source, over what window, at what expiry time, and which funded account pays ITM holders.                                                                    | All of `trade.options`                         |
| D8  | **Forex settlement law** — stablecoin-margined vs a true fiat omnibus. Note: `PAY_CRYPTO_ASSETS` can answer this **by accident** if someone maps `EUR` to a euro stablecoin.                             | All of `trade.forex`                           |
| D9  | **OTC minimum notional and maximum quote size.** SPEC A1 requires refusing an unfillably large request; there is no number to refuse against.                                                            | OTC completeness                               |
| D10 | **Copy: spot-only or leveraged for v1?** The spec is silent across all 166 lines.                                                                                                                        | Copy scope                                     |
| D11 | **Copy: the period boundary.** The cap is keyed on leader:follower with no period column, so it is currently a _lifetime_ cap and the decay threshold never resets.                                      | Copy settlement                                |
| D12 | **Which tier ladder is authoritative** for OTC — svc-token's `ACCESS_TIERS`, svc-identity's `thresholds.ts`, or the desk law's own `minStake`. Three exist; the desk reads only the third.               | OTC tiering                                    |

### Nitro — spend, config, and product posture

| #   | Decision                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N1  | **`TRADE_FUTURES_PROFIT_SOURCE`** — which account funds realised profit, and how it is capitalised. The mechanism is built and correct; `open()` refuses outright until this is set.                                                                                                                                     |
| N2  | **Confirm max leverage is 10×.** `DIRECTION:27` states it; `AFK-RESIDUAL-STOP-2026-08-07.md:38` disputes that agents may use it. It is currently **completely unenforced** — the only constraint is `leverage > 0`, and the column allows 999,999.99. One sentence unblocks a cap that can then be enforced immediately. |
| N3  | **Do paper markets belong in the public `fetchMarkets` listing?** (§2.8)                                                                                                                                                                                                                                                 |
| N4  | **Which rate limits are real** — the published `1200/600/20` that nothing enforces, or the edge's actual flat 300/min. They cannot both be the contract.                                                                                                                                                                 |
| N5  | **Should the six FX pairs stay listed while unfundable?** (§2.9) De-listing has public-API blast radius.                                                                                                                                                                                                                 |
| N6  | **`EDGE_TRUST_PROXY` for the deployed topology.** Left unset behind nginx, the rate limiter keys every caller into one bucket and throttles the whole platform as a single 300/min.                                                                                                                                      |

---

## 4 · Docs that are wrong on tip

Each of these would mislead the next agent that reads it.

| Where                                                                                          | Says                                            | Truth                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features.mjs` `trade.ccxt-api` note                                                           | "setLeverage/setMarginMode still not mounted"   | Both mounted as honest 501 `NotSupported`, and tested                                                                                                                                 |
| same note                                                                                      | "POST/DELETE positions with required exitPrice" | **Inverted** — caller-supplied prices are now refused with 400; the note describes the behaviour removed as a money bug                                                               |
| same note                                                                                      | implies no rate limit                           | A limiter exists at the edge, default on, 300/min                                                                                                                                     |
| `features.mjs` `trade.algo` note                                                               | "VWAP/POV still out (no honest volume series)"  | **A real, mm-excluded volume series exists** and is served publicly (§5)                                                                                                              |
| `features.mjs` `trade.forex` note                                                              | "no forex market is listed in production"       | Six are seeded `active`; they are _unfundable_, not unlisted                                                                                                                          |
| `features.mjs` `trade.futures` title                                                           | "cross/isolated margin"                         | Superseded — isolated only, and the ADR's Done bar requires **no cross path to exist even disabled**                                                                                  |
| `docs/ops/trk/trade.ccxt-api.md` §8, §10                                                       | blocked on Denon #433/#432                      | **Both merged.** `R-P-WS-INTEGRITY.md` on tip says PATH-CLEAR                                                                                                                         |
| `docs/ops/trk/trade.options.md`                                                                | blocked on Shehzad M3 + Denon multi-asset law   | Both dead — M3 reclaimed 2026-08-04, multi-asset law delivered as D-S-05                                                                                                              |
| `svc-trade/README.md`                                                                          | copy trading out of scope                       | Built (unreachable) since                                                                                                                                                             |
| `features.mjs` `trade.copy` title, `flags.ts:211`, `INTAFACED_DEFINITIVE_BUILD.md:242,256,264` | "profit share"                                  | **Profit share is banned** by `SPEC-SOVEREIGN-ROUTING-AND-COPY:95` in any form. The legal product is _fee_-share. Three artifacts an agent reads first still teach the banned design. |

---

## 5 · The one blocker that turned out not to be real

**VWAP and POV are not blocked by a missing volume series.**

`spot/candles.ts:45-60` sums `qty` over `trade.fills` filtered to taker liquidity **and** `order.seeded = false` **and** `counterparty.seeded = false` — market-maker volume excluded on both sides, which is exactly what the ADR asks for. It is live-computed per request and already served at `GET /api/v1/ohlcv/:symbol`.

The accurate statement is that the series is **thin**, not absent. The ADR's own words: _"an algo that participates at 10% of a volume figure that is mostly our own bot is a machine for trading against ourselves"_ — it blocks on **market maturity**, not on code, and reserves the call to the owner.

**Recommendation: still do not build VWAP/POV.** The honest next step is one read-only query counting non-seeded taker volume per market over 30 days, handed to the owner. That is a defensible artifact; building the algo is not.

---

## 6 · Suggested order for the rest of the lane

1. **TWAP: fix `algoPrincipals` durability, then mount the scheduler default-OFF.** Highest trader-visible value — TWAP currently accepts orders and never places one. The restart bug must land in the same change.
2. **Mount the copy router** and fix the exposure decrement, the two racy counters, and the mirror idempotency key. Thirty tests start protecting something.
3. **Flag paper markets on the public wire** (pending N3).
4. **Enforce the leverage cap** (pending N2 — one sentence, then a one-line guard).
5. **Publish hours on the public market payload** so a bot can tell "venue shut" from "exchange down", and add the holiday calendars — both schedules ship `holidays: []` against a schema comment warning that an empty list fails **open**.
6. **Correct the wrong docs in §4.** Cheap, and each one currently costs the next agent a wrong assumption.

Options (T5) and forex (T7) stay parked on D7 and D8. Neither can move without an owner ruling, and the honest thin slices for both are written up in the agents' reports.

---

## 7 · Confidence

High on everything cited to a file and line — every claim above was read at tip, and the three money bugs in §2.1–2.3 were re-read personally before being fixed.

**Not verified:** no test suite was run against a database. The DB-backed suites are CI-only on this machine (~10 skip locally in `svc-trade`), so every "tested" above means _the assertion exists and is specific_, not _it was watched passing_. CI is the gate, and PR #1097 is green there.
