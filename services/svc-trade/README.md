# svc-trade

**THE PRODUCT LAYER (§5.2).** Listings, the order lifecycle, and fees.

**What this service is not:** it does not match orders and it does not hold balances. The book lives in
svc-matching; the money lives in svc-ledger. This service is the thing in between — the one that decides an order
is allowed, funds it, hands it to the engine, and turns what comes back into ledger transactions.

**Primary shipped surface here:** `trade.spot` + mounted Convert / OTC / CCXT REST / futures-orderable path (flagged).

| Surface                                     | Mount             | Default                                                                       |
| ------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| Convert                                     | tRPC `convert.*`  | ON (`TRADE_CONVERT_ENABLED`)                                                  |
| Convert for a bank schedule                 | tRPC `standing.*` | OFF (`TRADE_STANDING_INSTRUCTION_ENABLED`)                                    |
| OTC                                         | tRPC `otc.*`      | mounted; blank §8 law → refuse-closed                                         |
| Algo TWAP create/ctrl                       | tRPC `algo.*`     | create ON; **scheduler job OFF** (`TRADE_ALGO_JOBS_ENABLED`, denylist enable) |
| Copy                                        | tRPC `copy.*`     | mounted; blank §8 fee-share + jurisdiction laws → refuse-closed               |
| Futures jobs / candle / MM seed / reconcile | job hosts         | **OFF**                                                                       |

`support.tradeSummary` (D-ops-06, query only, svc-support only): one customer's futures positions, liquidation rungs and orders for support, cut to a required `limit` (no default). svc-support checks the case first; this door proves the caller, reads the three lists in one snapshot, and writes a `trade.operator_audit` row (agent, case, customer, `auditId`, `readAt`) before it returns. A failed section or audit write refuses (`trade.support_summary_unavailable`, `trade.support_summary_audit_unavailable`); it never returns an empty list. Code: `src/support/`.

Wave-3 sealed money on tip (#1193 TWAP respace+jobs OFF, #1191/#1199 copy races, #1202–#1207 funding/insurance/reconcile, #1211 margin-call). See tracker `trade.copy` / `trade.algo` and [Not in this PR](#not-in-this-pr).

---

## The one thing that matters

svc-matching is allowed to be pure — no balances, no users, no affordability checks — on exactly one condition:
**every order it ever sees is already funded.** This service is that condition.

```
1 · auth + scope check (trade:write)
2 · risk checks — market status, tick/lot grid, size limits, min notional
3 · ledger.post(recipes.orderHold(...))     ← quote for buys, base for sells
4 · submit to the matching engine
5 · on Fill    → ledger.post(recipes.tradeFill(...))
6 · on Cancel  → ledger.post(recipes.orderHoldRelease(...))
```

Step 3 before step 4 is the whole design. Reverse them and a fill can print against money that is not there — and
a printed fill cannot be un-printed, because the counterparty has already been told they traded.

---

## API

tRPC, `src/router.ts`. Every amount on this boundary is a **decimal string**, in and out: `Amount` is a scaled
bigint and bigint does not survive JSON, while a JS number would round away the 18th decimal place — which is
where the ledger reconciles.

| Procedure        | Scope                        | Input                                                                              | Output     |
| ---------------- | ---------------------------- | ---------------------------------------------------------------------------------- | ---------- |
| `health`         | —                            | —                                                                                  | `{ ok }`   |
| `markets.list`   | — (public)                   | —                                                                                  | `Market[]` |
| `markets.get`    | — (public)                   | `{ symbol }`                                                                       | `Market`   |
| `orders.create`  | `trade:write` + jurisdiction | `{ symbol, side, type, qty, price?, timeInForce?, clientOrderId?, subAccountId? }` | `Order`    |
| `orders.cancel`  | `trade:write`                | `{ orderId }`                                                                      | `Order`    |
| `orders.get`     | `trade:read`                 | `{ orderId }`                                                                      | `Order`    |
| `orders.open`    | `trade:read`                 | `{ marketId? }`                                                                    | `Order[]`  |
| `orders.history` | `trade:read`                 | `{ limit, marketId? }`                                                             | `Order[]`  |
| `fills.mine`     | `trade:read`                 | `{ limit }`                                                                        | `Fill[]`   |

**Dead-man switch.** `POST /api/v1/orders/cancel-all-after {timeout}` (seconds) arms a countdown for the caller; re-send it to push
the deadline out, `timeout: 0` disarms. When the deadline passes, a sweep (every `TRADE_CANCEL_ALL_AFTER_SWEEP_INTERVAL_MS`) cancels
every open order of that user through `cancelAllOrders`. Allowed timeouts are `TRADE_CANCEL_ALL_AFTER_TIMEOUTS_SEC` (blank = arming
refuses `trade.cancel_all_after_unset`); the credential must outlive the deadline. The countdown is the durable row
`trade.cancel_all_after`, holding the caller's own claims, never a token.

**Batch cancel.** `POST /api/v1/orders/batch-cancel` takes up to 100 order ids (`{ids}`, `{orders:[{id}]}` or a bare array) and cancels them one by
one through the same path as `DELETE /api/v1/orders/:id`. Results are per item (`success`, `refused`, `unknown`), never atomic; scope and jurisdiction
are checked before any item, and a repeated id is refused.

`trade:withdraw` appears nowhere, deliberately: it is an `INTERACTIVE_ONLY_SCOPE` that no API key may hold, which
is what protects a leaked bot key from moving value off the platform.

**Order types:** `limit` and `market`. **TIF:** `GTC`, `IOC`, `FOK`, `PO`. Reading a listing is public; placing
an order is `trade:write` and goes through the jurisdiction matrix. Cancelling deliberately is **not** gated on
the market being tradable or on the kill-switch — an operator who halts a market must still let users out, and a
control that traps funds is not a safety control.

### Operator surface

`listMarket()` and `setMarketStatus()` are service methods with no user-facing route. A listing decides the tick
and lot grid and therefore decides whether a legal fill on that market can be worth nothing.

**Futures contract families, expiry tenors and pre-market (D-instruments-03).** Operator tRPC under `admin.*`, writes
need `admin:write` and a second operator's `approvalId` (four-eyes), all idempotent on `clientRequestId` and audited:

| Procedure                                          | What it does                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `admin.futuresListing.create`                      | lists a dated futures market through `listMarket`; a second create for the symbol returns the first, writes nothing |
| `admin.futuresSchedule.get` / `.set`               | owner tenor table (weekly, monthly, quarterly, enabled or not); versioned; blank is `no_schedule_published`; no job |
| `admin.futuresPremarket.get` / `.set` / `.convert` | owner flat funding rate and mark clamp band per market; convert moves `pending` to `active` in one transaction      |

The listing record carries `family` (`linear` only; `inverse` refuses `trade.inverse_family_unsupported`) and
`settleAsset` (the quote asset; USDC needs `TRADE_FUTURES_SETTLE_ASSETS` to name it). Blank pre-market params refuse
`trade.premarket_params_unset`. The public market read (`GET /api/v1/markets`, `markets.list`) shows `family`,
`settleAsset`, `contractSize` and `premarket`.

**Derivatives access (D-account-07).** A futures open (`POST /api/v1/positions` or `POST /api/v1/futures/orders`, not
reduce-only) needs the verification tier the published eligibility rules name (`trade.identity_level_insufficient`,
`trade.identity_level_unavailable`); with no rules published nothing is added to the jurisdiction matrix's own tier check.
No risk agreement, margin terms, suitability quiz or ADL acknowledgement gates an open or a copy (owner decision 2026-10-27,
until launch prep). The operator doors below still publish and list that content. The verification tier is the caller's own
principal claim; no identity vendor is called from this service.

| Door                                  | What it does                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `admin.agreements.get` / `.publish`   | new version per kind with one text per jurisdiction; four-eyes, append-only (a published version is never edited), audited |
| `admin.agreements.list` / `.export`   | compliance view of stored acceptances; the CSV export is capped by `TRADE_OPERATOR_EXPORT_CAP` (blank refuses) and audited |
| `admin.eligibilityRules.get` / `.set` | versioned questions, pass mark and minimum tier; any blank part refuses `eligibility_rules_incomplete`                     |

**Charts module owner values (C-ops-04, LD-14).** Five counts and a data class per market, held here until account sync
exists. Blank is `null` ("not set"); nothing has a default. Operator writes need `admin:write`, a reason, and a
`clientRequestId` (idempotent); each write leaves an audit row (`chart_owner_values.set` or `chart_data_class.set`) with the
old value, the new value, the reason and the time, written in the same transaction as the change, so a failed audit refuses the
change (`trade.chart_owner_values_not_written`).

| Procedure                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin.chartOwnerValues.get` | the current scalars (`version`, `values`) and every listed market's data class (`dataClasses`, at most 500)                                                                                                                                                                                                                                                                                                       |
| `admin.chartOwnerValues.set` | one key per write: `compareCap` (1-50), `chartCountLimit` (1-64), `drawingCap` (1-10000), `brushPointCap` (1-100000), `delayedBoundarySeconds` (1-86400), or `null` to clear; `expectedVersion` for optimistic concurrency. A `dataClass` write (`real_time`, `delayed`, `end_of_day`, or `null`) also takes `symbol` and an `approvalId` from a second operator (four-eyes, bound to the payload and the symbol) |

Scalars are one append-only snapshot per version (`trade.chart_owner_values`); a data class is one append-only row per market and
version (`trade.chart_data_class`). A stale `expectedVersion` refuses `chart_owner_values_stale`; a reused approval refuses
`approval_reused`. The public read is `GET /api/v1/charts/owner-values[?symbol=BTC%2FUSDT]`: plain JSON with no envelope and no auth,
`{ compareCap, chartCountLimit, drawingCap, brushPointCap, delayedBoundarySeconds, dataClass }`, where each count is an integer or `null`
and `dataClass` is the symbol's class, or `null` without `?symbol`. An unknown symbol is `trade.market_not_found` (404, `BadSymbol`). An
unwired reader refuses 503 `trade.charts_owner_values_unconfigured`. Edge forwards it through the existing `/api/v1` prefix, so no Edge
change is needed.

A data class write that fails after its approval is consumed says so in the refusal: the approval is spent, and a retry needs a new
approval from a second operator. A repeat of the same scalar write (same `clientRequestId`, same fields and reason) replays the stored
result, even when it races the first; the same `clientRequestId` with a different reason refuses `client_request_conflict`. A symbol
over 64 characters is `BadSymbol` 404, the same shape as an unknown one. Migration `0098_chart_owner_values.down.sql` is destructive: it
drops both tables, so every owner value and data class row is lost. Run it only on a database with no live values, never on a stack
that holds them.

---

## Events

**Publishes**

| Subject                        | When                                                                          | Idempotency key            |
| ------------------------------ | ----------------------------------------------------------------------------- | -------------------------- |
| `intafaced.identity.xp.earned` | an order reaches a terminal state having filled at least partly (§5.2 step 4) | `trade.order.xp:<orderId>` |

This service publishes **no subject of its own**. `intafaced.trade.*` is not in `packages/events/src/catalog.ts`,
and adding one is a contracts/events PR that comes first (§15.2) — so the only thing emitted here is a subject the
catalog already declares. svc-identity is the only writer of rank state (§4.1); this service says what happened
and has no opinion about what it is worth.

**Consumes**

| Subject                              | Consumer (durable) | Effect                                                                 |
| ------------------------------------ | ------------------ | ---------------------------------------------------------------------- |
| `intafaced.matching.order.filled`    | `trade-fills`      | `tradeFill` recipe, then close out both orders                         |
| `intafaced.matching.order.cancelled` | `trade-cancels`    | release the remainder of that order's hold, once its fills are settled |

These are the **recovery path**. A submission settles its own fills inline from the engine's response; the engine
also publishes every match to NATS regardless, so a process that died between the engine printing a fill and this
service settling it heals when the event is delivered. Both handlers are idempotent twice over — `idempotent()`
around the handler, and business keys underneath — because at-least-once is the only delivery there is, and a
redelivered fill that settled twice would pay a counterparty out of a hold that only funded one trade.

The two subjects are separate durables, so a cancel can arrive before the fill it follows. The cancel names the
remaining quantity; while `trade.fills` holds less than the engine filled, it refuses (`trade.cancel_ahead_of_fill`)
and is redelivered. If the fill never settles within the delivery budget the cancel is abandoned and the hold stays
with the order, where it can be found, instead of going back while a fill is still owed.

---

## Ledger

Every recipe this service invokes, and what it touches. **No new recipes were added** — `orderHold`,
`orderHoldRelease` and `tradeFill` already existed in `packages/ledger-client/src/recipes/`.

| Recipe             | Reason code           | Accounts                                                                                                 | Idempotency key             |
| ------------------ | --------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------- |
| `orderHold`        | `order.hold`          | user available → user hold                                                                               | `order.hold:<orderId>`      |
| `tradeFill`        | `trade.fill`          | taker hold → maker available + `houseFees('trade')`; maker hold → taker available + `houseFees('trade')` | `trade.fill:<fillId>`       |
| `orderHoldRelease` | `order.hold.released` | user hold → user available                                                                               | `order.release:<orderId>:0` |

**Every key is a business key.** `fillId` derives from `(marketId, engineSequence)` — the engine's own business
key for a match — and `orderId` derives from `(userId, marketId, clientOrderId)` when the caller supplies one, so
a retry from a bot, a redelivery from JetStream, or an operator replaying a day all compute the same key and the
ledger returns the original transaction. On the **spot live place path**, `crypto.randomUUID()` is used only when
the caller omits `clientOrderId` — and that order is the only live place a retry can double-hold. Elsewhere in this
service UUID generation is used for paper place, OTC quote ids, copy follow ids, and futures position ids (position
open has no client idempotency key — see audit residual).

### Seed / mm honesty (Spec SD-2…SD-4)

| Rule              | Behavior                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Flag**          | `orders.seeded` + `OrderRecord.seeded` (migration `0004_order_seeded`); MM seed records at rest via `recordSeededOrder` (D26-P1-T10) |
| **Place**         | `placeOrder({ seeded: true })` only when `seedPlaceEnabled` (wired to `TRADE_MM_SEED_ENABLED`, SD-4)                                 |
| **Fill account**  | Seeded house-MM `orderFilled` recovers `house:market-maker` (never empty / HOUSE_MM_USER_UUID as a customer-looking id)              |
| **Public volume** | `publicTape` / candles exclude fills involving any seeded order (SD-3)                                                               |
| **Cross ban**     | Seed submits are limit `PO`; synchronous engine fills → `manufactured_cross` + hold release (SD-5)                                   |
| **F8**            | seed↔seed prints never inflate public tape                                                                                           |

### OHLCV / candles (A-TRADE-SPOT-1 + A-TRADE-SPOT-OPS)

| Path                                 | Behavior                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **REST** `GET /api/v1/ohlcv/:symbol` | Live SQL aggregation from non-seeded taker fills (`queryCandlesFromFills`). Empty market → `[]`. Gaps stay gaps — never zero-filled.             |
| **Job** `TRADE_CANDLE_JOBS_*`        | Default **OFF**. When enabled + market ids set, materializes _closed_ buckets into `trade.spot_candles`. Never invents markets or empty candles. |

#### Ops enable path (default safe)

Job stays **OFF** until an operator deliberately enables it. Missing market list or empty mids → job host not scheduled (never invent a market list).

| Env                             | Default | Meaning                                                                                                                                                        |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRADE_CANDLE_JOBS_ENABLED`     | `false` | Master kill. Only `1` / `true` / `on` / `yes` turns on.                                                                                                        |
| `TRADE_CANDLE_JOBS_INTERVAL_MS` | `60000` | Tick interval when enabled (5s–1h).                                                                                                                            |
| `TRADE_CANDLE_JOBS_MARKET_IDS`  | `""`    | Comma-separated **market UUIDs**. Empty → no job even if enabled.                                                                                              |
| `TRADE_CANDLE_JOBS_TIMEFRAMES`  | `""`    | e.g. `1m,5m,1h`. Blank / all-invalid → refuse when enabled + markets (`trade.candle_jobs_timeframes_unset`). Never invent `1m`. Owner may set `1m`.            |
| `TRADE_CANDLE_JOBS_LIMIT`       | `""`    | Max buckets per market/TF per tick (1–1000). Blank → refuse when enabled + markets (`trade.candle_jobs_limit_unset`). Never invent `500`. Owner may set `500`. |

**Enable checklist (ops):**

1. Confirm REST ohlcv already honest for a traded symbol (`[]` if never filled — not fake zeros).
2. Set `TRADE_CANDLE_JOBS_MARKET_IDS` to real `trade.markets.id` values only.
3. Set `TRADE_CANDLE_JOBS_TIMEFRAMES` (e.g. `1m`) and `TRADE_CANDLE_JOBS_LIMIT` (e.g. `500`) explicitly — blank refuses, never invents.
4. Set `TRADE_CANDLE_JOBS_ENABLED=true` on the svc-trade process you intend to materialize (not every replica blindly).
5. Watch logs for `candle materialize ok` with `written > 0` only when closed buckets have real fill volume.
6. Kill: set enabled false or clear market ids — REST path keeps working from fills.

### Trailing-stop mark pump

Default **OFF**. A trailing stop walks with a mark, and the mark never comes from a customer. When enabled, each tick reads a labelled mark from the market's own book (stale, one-sided or thin books give none) and posts it to svc-matching `POST /markets/:marketId/mark`. A market with no usable mark is skipped; nothing is posted in its place.

| Env                                    | Default | Meaning                                                                                                                      |
| -------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `TRADE_TRAILING_MARK_JOBS_ENABLED`     | `false` | Master kill. Only `1` / `true` / `on` / `yes` turns on.                                                                      |
| `TRADE_TRAILING_MARK_JOBS_INTERVAL_MS` | `""`    | Tick interval in ms. Blank → refuse when enabled + markets (`trade.trailing_mark_jobs_interval_unset`). Never invent a rate. |
| `TRADE_TRAILING_MARK_JOBS_MARKET_IDS`  | `""`    | Comma-separated **market UUIDs**. Empty → no job even if enabled.                                                            |

**Placing a trailing stop** (sell side only for now): the customer sends `trail`; a `mark` in the body is refused (`trade.order_type_unsupported`). The starting mark comes from the same source, and only while the pump is enabled and the market is in `TRADE_TRAILING_MARK_JOBS_MARKET_IDS` (a stop elsewhere would never move). No usable mark refuses `trade.missing_mark`. A buy trailing stop refuses `trade.order_type_unsupported` until its funding hold is built.

**Honesty bans:** invent candles, invent markets, zero-fill gaps, include seed volume in public ohlcv (seeded fills excluded — SD-3).

### Venue fabric mark (A-TRADE-VENUE-1 + A-TRADE-VENUE-OPS)

Public mid from §27 venue fabric (`packages/venue-adapter`) preferred over matching depth for futures mark ticks when configured. **Default OFF** — empty venue id means depth-only marks (or null when book empty). Never invents a mid.

| Path                                      | Behavior                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mark** `TRADE_VENUE_MARK_*`             | When venue id + symbol map set, `createConfiguredVenueMarkSource` builds a `MarkSource` from the public book; futures jobs prefer it, then depth. `TRADE_VENUE_MARK_STREAM` (default OFF) uses sequenced `MaintainedBook` instead of polling `snapshotBook`. Desynced feed → null. |
| **MM mid** `TRADE_MM_SEED_MID_FROM_VENUE` | Default **OFF**. When true, after env mid map miss, MM seed may use the **same** venue adapter + symbol map. Still skips market if mid null.                                                                                                                                       |
| **OTC mid** `TRADE_OTC_MID_FROM_VENUE`    | Default **OFF**. When true, OTC RFQ mids come from the **same** public adapter; `TRADE_OTC_VENUE_SYMBOLS` maps pairKey→symbol. Unmapped/dark → null. Boot `TRADE_OTC_MIDS` is not mixed in.                                                                                        |

#### Ops enable path (default safe)

| Env                            | Default | Meaning                                                                                                                                                                      |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRADE_VENUE_MARK_VENUE`       | `""`    | Venue id. Empty = mark port off. Known public adapters: **`binance-spot`**, **`bybit-spot`**, **`okx-spot`** — all keyless. Unknown id → warn once, stay off (never invent). |
| `TRADE_VENUE_MARK_SYMBOLS`     | `""`    | `marketId:BTC/USDT,other:ETH/USDT` — our market UUID → venue unified symbol. Unmapped market → null mark for that id.                                                        |
| `TRADE_VENUE_MARK_STREAM`      | `false` | When true, start one `MaintainedBook` per mapped symbol (stream-first + snapshot join). Default off so boot does not open WS. Desynced → null mark.                          |
| `TRADE_MM_SEED_MID_FROM_VENUE` | `false` | Optional MM mid fallback from the same venue map. Only `1` / `true` / `on` / `yes` turns on.                                                                                 |
| `TRADE_OTC_MID_FROM_VENUE`     | `false` | Optional OTC observation feed from the same public adapter. Default off.                                                                                                     |
| `TRADE_OTC_VENUE_SYMBOLS`      | `""`    | `BTC/USDT:BTC/USDT` — OTC pairKey → venue unified symbol. Empty = every pair unmapped (never invent).                                                                        |

**Enable checklist (ops):**

1. Pick the venue and confirm its public path is acceptable for this environment (egress, rate limits). `binance-spot` spends request WEIGHT against a 6000/min IP budget; `bybit-spot` spends one REQUEST against a 600-per-5s IP budget; `okx-spot` spends against a documented 10 requests / 2 seconds IP budget. Governors reserve 20% headroom, and refuse rather than silently waiting.
2. Set `TRADE_VENUE_MARK_SYMBOLS` to real `trade.markets.id` → venue symbols only (never invent symbols). The symbol format is the unified one (`BTC/USDT`) for either venue — the venue's own spelling is produced inside the adapter and nowhere else.
3. Set `TRADE_VENUE_MARK_VENUE=binance-spot`, `bybit-spot`, **or** `okx-spot` on the svc-trade process that runs futures mark / MM (not every replica blindly if you do not want external polls). One venue at a time: this mount takes a single id, and a mark is preferred-then-fallback, not a cross-venue median. Optional: `TRADE_VENUE_MARK_STREAM=true` to consume `MaintainedBook` instead of polling (still default off).
4. Health: process log / ready payload includes `venueMark: { venueId, symbols }` when configured; absent when off.
5. Optional MM: after env mids map is trusted or deliberately empty, set `TRADE_MM_SEED_MID_FROM_VENUE=true` — still skips any market with no mid.
6. Optional OTC: set `TRADE_OTC_VENUE_SYMBOLS` to real pair keys (never invent a catalogue) then `TRADE_OTC_MID_FROM_VENUE=true`. Dark/unmapped pairs still refuse. Boot `TRADE_OTC_MIDS` is not a fallback while this is on.
7. Kill: clear `TRADE_VENUE_MARK_VENUE` or symbols — marks fall back to matching depth mid only; OTC venue feed also goes dark (never invent).

**Honesty bans:** invent mid, invent second venue adapter without fabric support, treat empty/one-sided book as a price, treat account observations as ledger truth, enable trading half of venue (credentials / Vault) as if public mark worked.

**Second venue:** shipped 2026-08-08 as `bybit-spot`. **Third venue:** shipped 2026-08-14 as `okx-spot` (public market data only; no trade or account half; no credential is read). The bar was and remains: a real `MarketDataAdapter` in the fabric **and** `createVenueMarketDataAdapter` knowing the id — do not stub a name. A fourth venue is not needed by any open residual on `venue.aggregation`.

Seeder process resume (SD-1/SD-6) is a separate eng residual.

### Reconcile open ↔ hold ↔ engine (Spec CX-9)

Operator recovery for a **single** suspect order (not cancel-all):

| Case                                           | Detection                                        | Action                                                                  |
| ---------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| **orphan pending**                             | `pending` + ledger hold 0                        | delete row                                                              |
| **open+hold, engine live**                     | `open` + hold > 0 + engine **list** hit          | cancel then release remainder once                                      |
| **open+hold, engine miss, proven empty fills** | list miss + `trade.fills` empty + `filled_qty` 0 | release remainder once                                                  |
| **open+hold, engine miss, unknown fills**      | list miss + fills do not prove no fill           | **fail closed** — named break, hold stays (never auto-refund)           |
| **open+engine no hold**                        | `open` + hold 0                                  | **fail closed** — never invent hold; cancel free book risk if list live |

Liveness is `MatchingClient.listOrders` (GET), not cancel-as-probe. Cancel is repair.

```ts
await trade.reconcileOrder(orderId);
// tests: src/spot/order-route-reconcile.test.ts
```

### Scheduled engine ↔ ledger reconcile (A10)

Default **OFF**. Builds the counterpart view from `trade.orders` (open/pending) + **live** hold balances, POSTs matching `POST /reconcile`, and:

| Engine finding                         | Local action                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| **refuse** (incl. open+hold no engine) | **write nothing** — warn log / alert only                                                |
| **auto** unfunded **pending**          | DELETE intent row only (moves no value)                                                  |
| **market-id set drift** (handoff §4.5) | **alarm only** — `trade.markets` vs engine `GET /markets`; never invents/deletes markets |

Does **not** call `reconcileOrder` (operator tool: engine-miss releases only when `trade.fills` prove empty). Env: `TRADE_RECONCILE_JOBS_ENABLED`, `TRADE_RECONCILE_JOBS_INTERVAL_MS`.

```ts
// pure + tick: src/spot/engine-ledger-reconcile.ts
// job host:   src/spot/engine-ledger-reconcile-jobs.ts
// tests:      src/spot/engine-ledger-reconcile.test.ts
```

### Order-path smoke (Spec CX-8)

Assembled health probe (trade + matching + ledger HTTP):

```bash
pnpm order-path-smoke
# fleet up → PROOF_OK assembled-health
# fleet down → HONEST_SKIP exit 0 (set ORDER_PATH_SMOKE_STRICT=1 to fail CI when down)
```

In-process chaos + property suites (`order-route-chaos.test.ts`, `order-route-properties.test.ts`) are the CI seal for hold/fill/idempotency without inventing live fills.

### clientOrderId policy (Spec CX-11)

| Rule                   | Guidance                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Recommend**          | Always send a unique `clientOrderId` per intent (global unique or day-scoped + user+market is enough). Retries must reuse the **same** id. |
| **Exactly-once place** | Same `(userId, marketId, clientOrderId)` → one order, one hold, one engine submit (chaos F1).                                              |
| **Unsafe**             | Place without `clientOrderId` then retry on timeout — a second UUID is a second hold.                                                      |
| **Constraint**         | Uniqueness is enforced by deterministic order id derivation + order row insert; DB unique on client id is optional hardening residual.     |

### Where the money is, at every point

| State                               | Where the funds are                                       |
| ----------------------------------- | --------------------------------------------------------- |
| `pending`                           | still in the user's `available` — nothing has been posted |
| `open`                              | `hold`, minus whatever fills have already drawn down      |
| `filled` / `cancelled` / `rejected` | back in `available`, or paid to the counterparty          |

**One release per order, ever** — sequence `0`, fixed. An order reaches a terminal state exactly once, so the key
never needs to vary, and a fixed key is what makes a double-release impossible rather than merely unlikely.

---

## If this crashes exactly here, whose funds are stranded?

The question asked of every step, and the answers the code is shaped around.

| Crash point                                   | Whose funds | Why not                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After the risk checks, before the intent row  | nobody      | Nothing has been written and nothing posted.                                                                                                                                                                                                                                                                           |
| After the intent row, before the hold         | nobody      | A `pending` row has no ledger post behind it and no engine presence. The only correct recovery is to delete it — and that is the only thing it can do. This is why the row comes **before** the hold: a hold posted against an order id that exists nowhere is money nobody can find.                                  |
| After the hold, before the engine             | nobody      | The row is `open` with its hold intact. Cancelling it releases in full; svc-matching answers `404` for an order it never took, which is an answer, not an error.                                                                                                                                                       |
| The engine submission fails at the transport  | nobody      | **Indeterminate** — the engine may hold the order. The hold is deliberately _kept_, because releasing funds for an order that might be live in the book is exactly the failure this ordering exists to prevent. Recovery is a cancel.                                                                                  |
| After a fill row, before the `tradeFill` post | nobody      | Fills stay ahead of the ledger so `consumed` is never understated. **Fee-exhaust class is different:** if fees leave a side with nothing, `tradeFill` throws forever — so `settleFill` now refuses with `trade.fee_exceeds_fill` _before_ inserting rows. Ordinary post failures still heal on re-run of the same key. |
| After the release, before the terminal status | nobody      | Terminal status is what makes `finalize` return early, so the release happens **first**. A crash leaves a non-terminal row, a retry recomputes the same remainder, and the fixed release key makes the second post a no-op.                                                                                            |

The one ordering that is **not** safe, and is therefore not used: posting `tradeFill` before recording the fill.
A crash there understates `consumed`, and the next release hands back money the fill already spent — drawn out of
whatever else that user has in `hold`. That is one order silently paying for another.

---

## Funding a market buy

A market order carries no price, so there is no honest amount to hold for it. The order is funded at
`bestAsk × (1 + TRADE_MARKET_SLIPPAGE_CAP_BPS)`, rounded up to the tick, and submitted to the engine as a
**marketable IOC limit at exactly that price**. Blank / unset / non-integer cap refuses
(`trade.slippage_cap_unset`) — never invent 200. The engine therefore physically cannot fill it above what was
held — the funding invariant survives even if the book moves between the depth read and the submission, because a
book that moved up simply fills less. Anything the fill did not spend comes back with the remainder.

A market **sell** needs none of this: the hold is base quantity, which is known exactly whatever the price does.

**Per-order tolerance.** A market order on the create-order route may carry `maxSlippageBps` (a whole number from 1
up to the owner cap). It only tightens: the buy is funded and sent at the tighter of the two prices, and a sell's
floor is the higher of the two. A value above the owner cap, a non-integer, or one on a limit order is refused with
`trade.slippage_tolerance_invalid` before any hold; it never stands in for an unpublished owner cap. The order preview
accepts the same field and shows the tighter protection price and hold, or the same refusal.

## Rounding, stated

| Quantity               | Direction | Why                                                                                                                                                                                        |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| buy hold `price × qty` | **ceil**  | A hold one wei short is a fill the ledger will refuse at settlement, after the book has already moved on.                                                                                  |
| fill `price × qty`     | **floor** | A sum of floored parts can never exceed the ceiling of the whole, so a partial fill can never out-spend its hold. The leftover wei is released with the remainder — it is not left behind. |
| fee rate discount      | **floor** | Value credited to a user is floored so rounding never invents value that has to come from somewhere.                                                                                       |

---

## Fee tiers

svc-identity publishes a machine-readable perk table; this service applies the one field it cares about,
`feeDiscountBps`, without knowing what a rank means. The effective rate is
`published − floor(published × discountBps / 10000)`.

It is read **once, at order placement**, and snapshotted onto the order row. Two consequences, both deliberate:

1. A rank change cannot retroactively re-price an order that was already accepted on the old terms — the same
   reason `token.stakes` snapshots its multiplier at open.
2. The fill path makes **no network call**. A fill must settle even when svc-identity is down, because by then
   the match has printed and the counterparty is already owed.

The read fails **closed**: an order is refused if the perk table cannot be read. Nothing has moved at that point,
which is exactly why it is the right place to be strict.

> **Known limitation, stated rather than hidden.** `tradeFill` takes fee rates as integer basis points, so a
> small discount on a small published fee rounds away entirely — 25 bps of discount on a 10 bps maker fee is
> 0.025 bps, which is not representable. **SOCKET §13 — amount-level fee discounting**: applying the discount to
> the fee _amount_ keeps all 18 decimal places and is exactly what `feeCharge`'s token branch already does. It
> needs `tradeFill` to accept fee amounts instead of bps, which is a `packages/ledger-client` change and
> therefore its own PR first (§15.2).

### Volume tiers (`tierProgram`, J-cex-spot-10 #5-#6)

A rows fee schedule may carry the owner's `tierProgram`: volume thresholds (`tierId`, `minVolume30d`), the quote
assets whose spot fills count (`volumeQuotes`, one unit each), and a daily `snapshotTimeUtc`. It is written through
the same two-person `admin.fees.set` door and versioned with the rows. Every threshold tier needs a row in every pair
group. Rules this service cannot apply yet (`downgradeGraceDays`, `subAccounts`, `botsAndCopy`, an asset tier
`minAssets`) must be written as `null` and refuse when set.

`spot/fee-tier-jobs.ts` (every `TRADE_FEE_TIER_JOBS_INTERVAL_MS`, blank is off) writes the snapshot due at the
programme's time: one `trade.fee_tier_snapshots` row per account under `tier-snapshot:<minute>:<userId>`, then the
`trade.fee_tier_snapshot_runs` row that puts it in force, in one transaction; a re-run writes nothing. Counted volume
excludes the house market maker, sub-accounts, other quote assets, and orders placed by an algorithm, an execution
child or copy trading. An order takes the tier of the last finished snapshot when it is placed and keeps it on the
row (`orders.fee_tier`). No programme means every account is regular. `GET /api/v1/account/fee-tier` gives the
caller's tier, counted volume, next threshold, next snapshot and own snapshot rows.

`tierProgram.benefits` (SP-fees-vip-03, J-cex-spot-10 #7) is the owner's benefits table: one row per tier
(`regular` or a threshold tier), each row carrying every field (`prioritySupport`, `vipPortal`, `ambassador` as
true/false, `subAccountCap` as a whole number, `withdrawalLimit24h` as `{asset, amount}`), `null` where the owner sets
none. Absent or `null` means no table. A field left out, an unknown field, a guessed type, an empty table, a repeated
tier or a tier the programme does not name refuses the schedule as blank. The table is what each tier is promised:
support and treasury read it, and nothing in this service applies it. My tier lists it; a blank cell reads "not set".

`tierProgram.application` (SP-fees-vip-04, J-cex-spot-10 #7) opens VIP applications: `proofTypes` (only types this
service recognises from a file's first bytes: `application/pdf`, `image/png`, `image/jpeg`) and `maxBytes` (1 to
5 MiB). Absent or `null`, every application refuses `vip.application_unset`. `POST /api/v1/vip/applications`
`{requestId, proof: {fileName, contentType, bytesBase64}, note?}` (`trade:write`) checks the type against the bytes,
then keeps the proof encrypted with `TRADE_VIP_PROOF_KEY` (32 bytes as hex or base64; AES-256-GCM bound to the row id
and the file's SHA-256; blank refuses `vip.proof_key_unset`) and appends a `pending` event. One application waits per
person (`vip.application_open`). The same `requestId` with the same file, name and note answers the application it
made (200), even after the rules change; with anything else it refuses `vip.request_reused`. A name or note with a
control or direction-override character refuses `vip.request_invalid`. `GET /api/v1/vip/applications` (`trade:read`)
answers the rules, `closed` (`vip.application_unset` or `vip.proof_key_unset` when not open, with `rules: null`) and
the caller's own applications, metadata only: the file never leaves the service on this door. The edge's
`EDGE_BODY_LIMIT_BYTES` also bounds an upload: base64 adds a third, so a `maxBytes` above three quarters of it is
refused at the edge first (the screen says the file is too large to upload).

Compliance decides an application on the operator desk (`admin.vipApplications`, SP-fees-vip-04 part 2): `list`
(`admin:read`) gives the applications with their history, any trial, the trial the owner publishes now and whether
proofs open; `proof` (`admin:compliance`, a reason, audited as `vip_application.proof_view`) opens one proof file.
`review` (`admin:write` and `admin:compliance`) takes `approve` or `reject` with a reason and consumes identity's `trade.vip_application_review`
approval, bound to the application, `pending`, the decision, the reason and the trial an approval would grant; the
operator who approved cannot also apply it. `tierProgram.trial {tierId, days}` (a threshold tier, 1 to 366 whole days)
is the trial an approval grants; absent or `null`, an approval leaves the application `approved_no_trial` and says
`vip.trial_unset`. `grantTrial` (the same scopes, approval `trade.vip_trial_grant`, bound to `approved_no_trial` and the
trial) grants it once one is published, and still refuses `vip.trial_unset` before any approval is consumed while none
is. A person with a trial in force is granted no second one (`vip.trial_active`). A trial is a `trade.vip_trials` row
keyed `vip-trial:<userId>:<applicationId>`, append-only, one per application, spanning whole 24-hour days.
`feeTierAt` charges the higher of the snapshot tier and a trial in force, each while the programme still names it, and
`GET /api/v1/account/fee-tier` names the trial the tier comes from (`trial`). The same approval sent again (or twice at
once) answers what it decided; for another decision or reason it refuses `approval_mismatch`, and for another
application `approval_reused`. A status only moves forward (a database
trigger), and each decision's event carries the approver and the approval.

---

## Database constraints as a backstop

The service checks these; the database enforces them regardless.

| Constraint                                | What it catches                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orders_hold_positive_ck`                 | **live orders must carry a non-negative hold** — was `> 0` at init; paper markets (`0006`) widened to `>= 0` so sim rows need no ledger post. Live `placeOrder` still posts `hold_amount > 0`; the CHECK alone no longer forbids an unfunded open row (service + paper isolation own that) |
| `orders_not_overfilled_ck`                | this service and the engine disagreeing about a book                                                                                                                                                                                                                                       |
| `orders_client_id_idx` (unique)           | a retried bot request opening a second position                                                                                                                                                                                                                                            |
| `fills_market_sequence_role_idx` (unique) | a redelivered fill event settling a match twice                                                                                                                                                                                                                                            |
| `markets_dust_free_ck`                    | a listing whose smallest legal fill is worth zero — the ledger will not post a movement of nothing                                                                                                                                                                                         |
| `markets_fee_bounds_ck`                   | a fee at or above 100%, which `tradeFill` would refuse to build entries for                                                                                                                                                                                                                |
| `orders_price_shape_ck`                   | a limit order with no price, or a market order carrying one                                                                                                                                                                                                                                |

---

## Copy deepen (D26-P1-T3)

`deskStatus().sovereign` is a legacy name for the intended policy shape: protocol-fee-share only, P&L fees and returns ranking forbidden, and real service-side kill/unfollow controls. The current implementation is a Fiat service path backed by service envelopes, a hashed service session key, and the ordinary platform ledger. It does not prove follower-owned on-chain scope or direct Protocol-plane revocation and must not be described as non-custodial or sovereign execution. **D26-P0-02** published `TRADE_COPY_FEE_SHARE_LAW` (1000 bps of our fee). **D26-P0-15** remains refuse-closed in every region under the accepted 2026-08-15 ADR: counsel has not supplied a served-jurisdiction list. The withdrawn 2026-08-14 example array has no authority and must not be deployed; blank `TRADE_COPY_JURISDICTION_LAW` refuses, compose has no default, engineers must not seed region codes, and a published empty list means serve none.

`copy.killFeeShare` and `copy.unfollow` are unilateral controls and remain reachable while the owner fee-share rates are blank. Every mirror plan, fee-share settlement, kill, and unfollow is serialized per follow:

- an already-started mirror or settlement finishes before kill/unfollow is acknowledged;
- after `killFeeShare` is acknowledged, a new fill cannot pay leader fee-share;
- after `unfollow` is acknowledged, a new mirror or settlement cannot use the deleted envelope;
- production SQL pins the advisory lock and guarded queries to one database connection, so the guarantee holds across service processes without exhausting the connection pool.

The public tRPC proof is `src/copy/router-mount.test.ts`. It blocks an in-flight ledger post/mirror claim, races the public kill/unfollow mutations against it, and proves the control waits before closing every later attempt. No §8 rate is supplied by production defaults; blank rates still refuse closed.

---

## Not in this PR

`trade.spot` only. §5.2 also specifies tables and behaviour that belong to other tracker features:

| §5.2 item                                                                      | Where it goes                                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `positions`, `funding_rates`, `insurance_fund`, liquidation ladder             | `trade.futures`                                                                                                                                         |
| options (European, cash-settled, full collateral)                              | `trade.options`                                                                                                                                         |
| `copy_follows`, `copy_mirrored_fills`, **fee-share** (P&L profit-share banned) | `trade.copy` — tRPC `copy.follow` / `killFeeShare` / `unfollow` / `settleFeeShare` / `deskStatus`; blank `TRADE_COPY_*` laws refuse; owner rates only   |
| `otc_quotes`, RFQ, staked-tier gate                                            | `trade.otc`                                                                                                                                             |
| Convert one-tap                                                                | `trade.convert` — **quote + execute on this service** (`convert.quote` / `convert.execute`; market IOC + house RFQ spread; same hold→fill path as spot) |
| TWAP / VWAP / POV                                                              | `trade.algo`                                                                                                                                            |
| internal market-maker bot, venue aggregation                                   | `trade.mm-bot`, `venue.aggregation`                                                                                                                     |
| CCXT REST/ws surface over this router                                          | `trade.ccxt-api`                                                                                                                                        |
| volume aggregates per user per window feeding fee tiers                        | `spot/fee-tier-store.ts` daily snapshot (see Volume tiers)                                                                                              |

The `market_kind` enum already carries `futures` and `options`, so listing one later is an `INSERT`, not a
migration.

**Stop and take-profit orders are refused** (`trade.order_type_unsupported`). The engine already matches them and
the public contract already carries `take_profit`, but funding them honestly is not solved: a stop _buy_ has no
price until it triggers, possibly days later, so either it is funded at submission against a price nobody can
predict, or it reaches the engine unfunded — and an unfunded order in the book is the one thing this whole design
exists to prevent. **SOCKET §13** — the fix is a trigger-time funding callback from svc-matching, which is a
change to that service's contract and therefore its own PR.

---

## Funding rate engine (D-instruments-01)

No money moves here; the funding tick still posts every leg. The computer only decides the period rate and hands it to the existing rate source.

- **Formula** (`futures/funding-rate-computer.ts`): rate = tail-trimmed mean of `(mark - index) / index` samples + owner base component, clamped to `[-cap, +cap]`. Scaled bigint in memory, decimal strings at rest. A missing sample is a gap: left out of the mean, counted against the minimum.
- **Owner numbers** (`trade.funding_params`, versioned per market, `admin.fundingParams.get/set`): base component, cap, cadence, trim ratio, minimum samples; `periodSeconds` and `periodAnchor` place the window for the scheduled job. All blank by default. A blank one refuses the period with `trade.funding_rate_unset`, the refusal is stored (`trade.funding_rate_periods`) and nothing is published.
- **Outcomes per period:** `published` (closed, immutable, replay returns the stored rate), `refused` (`trade.funding_rate_unset`, `trade.funding_samples_insufficient`, `trade.index_params_unset`, `feed.market`, or the existing bound codes), `paused` (`trade.funding_index_stale`: a red index waits, then is retried).
- **Index** (`futures/index-construction.ts`, `trade.funding_index_sources`, `admin.indexSources.get/set`): weighted multi-source with outlier rejection, owner floor (`minSources`), band (`outlierBandBps`) and age (`maxAgeSeconds`). The feed is a port; with none configured it answers NotConnected `feed.market`.
- **Mark** (`futures/mark-construction.ts`): `index_plus_basis` and `median_of_three` as pure functions behind `markSourceWithConstruction`; a blank selection returns the existing source unchanged.
- **Desk read:** `admin.fundingPeriods.recent` returns recent computed, paused and refused periods with their samples.
- **Wiring:** `TRADE_FUTURES_FUNDING_COMPUTER_POLL_MS` (blank = off). When set, each funding market gets a `futures.funding_rate.<market>` job that samples and computes its latest closed period; the funding tick asks the computed-rate book first and the S2S-fed book second.

## Kill-switch

`trade.spot` in the admin console, or `TRADE_SPOT_ENABLED=false`.

**Effect when off:** new orders are refused with `trade.spot_disabled` before anything is read or held. Cancels,
reads and listings keep working, and `/ready` returns 503 so the load balancer takes the instance out of the
order-placement rotation. Halting an individual market (`setMarketStatus`) is the finer-grained version and
behaves the same way: it stops new risk, it does not confiscate positions.

**One switch per plane.** `TRADE_SPOT_ENABLED` governs spot, `TRADE_FUTURES_ENABLED` governs futures, and neither
halts the other — an operator stopping spot has not stopped futures, and there is no version of a single boolean
standing for both that is the honest answer. Both refuse only NEW orders; a cancel is never refused by either,
because a switch that traps funds is not a safety control.

---

## Futures orderability (`TRADE_FUTURES_ENABLED`)

**Default off, and off is a product state rather than an outage.** With the flag off a futures market may be
listed, appears in `fetchMarkets`, answers its ticker and orderbook, and refuses an ORDER with
`trade.futures_disabled` — CCXT `NotSupported`, HTTP 403. Not `BadSymbol`, because the symbol is real and an
operator can turn the switch on; not `OnMaintenance`, because nothing is degraded or coming back on its own.

With it on, futures orders match on the **same** svc-matching book as spot, under the futures market's own id
(D-S-06 is Accepted — there is no second book), and settle through `packages/ledger-client` like any other fill.

**What the flag does not do**, because a name like `FUTURES_ENABLED` invites all three assumptions:

- **No leverage.** A futures order is funded by the same `holdFor` as a spot order — quote for buys, base for
  sells, in full. Orderability creates no margin position and picks no risk parameter; leverage and margin defaults
  beyond `DIRECTION` §1's are owner-only (§8 item 8). Leveraged entry remains `PositionService`'s path, behind its
  own gate and its own named profit source.
- **No funding.** Turning funding on for a market at all is reserved to the owner
  (`docs/adr/2026-08-05-futures-risk-and-mark-law.md`), and it still needs `TRADE_FUTURES_JOBS_ENABLED` plus an
  explicit `TRADE_FUTURES_FUNDING_MARKET_IDS`.
- **No payout source invent.** `TRADE_FUTURES_PROFIT_SOURCE` names the futures clearing pot, `house:futures-loss:available` in `.env.example` (`docs/adr/2026-10-20-futures-matched-traders.md`). Compose still has no default. A winner the pot cannot cover yet closes anyway and is owed: `trade.futures_payouts` holds the intent and the `futures.payouts` job pays it once the pot holds it; the trader reads it at `GET /api/v1/futures/payouts`.

**Convert and TWAP stay spot-only on both settings** (`assertSpotSurface`). They were spot-only for free while
`assertTradable` refused every non-spot market; now that it does not, they refuse by name, because neither has been
designed or tested against a market whose position is a margin row rather than a base-asset balance.

**Why this could not land before 2026-08-08.** The mark was size-blind, so two dust orders on a futures book minted
a payout-grade mid — `assertTradable`'s flat refusal was the only thing making that unreachable, and
`futures/mark-from-depth.ts` said so in its own header: "a different file's accident, not a control". `c7dfb5e4`
and `cc90c2f4` made both the internal-depth and venue mids size-aware and armed the deviation breaker against a
stored `accepted_mark`. `futures/orderable-path.test.ts` rests the dust through the real order path and asserts the
profit pot does not move.

---

## Running it

### Founder restrictions and operation admission

Apply migration `0048_account_controls.sql` before enabling controls. The protected
`accountControls.getState`, `history`, and `change` procedures own only the `trading`
target. Each command independently verifies the original interactive founder with
identity, including current session/MFA and revocable entitlement. Subaccount,
API-key, service, ordinary admin, missing authority, and malformed commands refuse.
Commands carry a reason, UUID request ID and expected version; actor-bound replay,
restriction/version changes and immutable attributed history commit together.

Production always installs the identity decision client. Configure `IDENTITY_URL`
and a dedicated `IDENTITY_ADMISSION_SECRET`; identity must configure the matching
`IDENTITY_TRADE_ADMISSION_SECRET`. This owner key must differ from generic service,
read-authority and other admission keys. Founder delegation also needs the existing
service-auth and edge principal-signing configuration. Missing configuration or
authority refuses fresh exposure; an authority snapshot is never an operation grant.

Fresh orders, native quantity increases, Convert execution, futures opens/leverage
increases, strategy starts, algorithm children and copy mirrors use owned immutable
intents. Preparation commits the original normalized payload and identity-request
marker before contacting identity. Finalization holds the same per-user owner guard
as restriction. Restriction resolves or cancels every marked pending intent before
committing; an uncertain granted intent becomes its original owner admission, never
a fresh admission under restriction. Each child/mirror needs its own decision and
verified persisted parent provenance; legacy parents lacking it refuse new exposure.

Cancellation, closing and recovery of original admitted effects remain available.
Internal `recoverAdmittedOrder`, `recoverAdmittedPosition` and `recoverAdmittedAlgo`
hooks reconstruct owned stored payloads after uncertain responses. They accept no
public admission receipts, and strategy recovery cannot rewind an existing parent.
These hooks are available to owner recovery workers; this change does not install a
new automatic recovery queue. Restoration permits new decisions but does not revive
revoked credentials or rebind an old strategy to a new credential.

```bash
docker compose up -d
pnpm --filter @intafaced/svc-trade db:migrate
pnpm --filter @intafaced/svc-trade test
pnpm gate svc-trade
```

## Tests

70 tests. 31 are pure — fee rate arithmetic and every risk check — and run without a database, because the rate
they compute is the number handed to a six-entry ledger recipe and getting it wrong fails silently rather than
loudly.

The remaining 39 run the money paths against **real Postgres** with the ledger's in-memory reference
implementation, which the conformance suite proves equivalent to svc-ledger's Postgres engine (§4.4). Postgres is
real because the release amount is derived from the fills table, so "what does the database actually contain" is
load-bearing.

The matching engine is a **stub**, and deliberately: §15.2 forbids one service importing another's source,
svc-matching has 76 tests of its own covering the book, and what is under test here is svc-trade's _ordering_ —
not whether price-time priority works. The stub speaks svc-matching's published wire shapes, decimal strings and
all.

**Failure branches covered:** insufficient funds on a buy and on a sell (no row, no engine submission), a refused
hold retried, cancel before any fill, cancel after a partial fill (only the remainder, exactly once), a second
cancel, a redelivered cancel event, a redelivered fill event, an IOC remainder, a resting order pulled by
self-trade prevention, an engine rejection, an unreachable engine mid-submission, a halted market, cancelling out
of a halted market, the kill-switch, a missing scope, off-grid price, off-grid quantity, sub-minimum notional, a
stop order, a market buy with no ask to price against, a perk table that cannot be read, and six concurrent
identical submissions.

**Invariants asserted:** `ledger.totalsByAsset()` is zero for every asset after every settlement path;
`ledger.reconcile()` and `ledger.verifyChain()` are clean after a run of mixed operations; `orders.filled_qty`
always equals `SUM(fills.qty)`; the sum of open orders' `hold_amount` always equals the ledger's `hold` balance,
per asset; no `available` or `hold` balance ever goes negative; and no terminal order consumed more than it held.

## Standing-instruction convert (auto-invest)

`standing.quote` and `standing.execute` let svc-bank run a customer's auto-invest schedule through the same firm quote, ledger recipes and idempotency as `convert.*`. There is no session or API key: the call is an authenticated service call (svc-bank only; the user and instruction ids come from the signed body), and admission names the `standing_instruction` authority, which svc-identity decides. The door is OFF by default (`TRADE_STANDING_INSTRUCTION_ENABLED`, refuses `trade.standing_instruction_disabled`); turn it on only once identity decides that authority. Limits to know: svc-bank and the other services share one `INTERNAL_SERVICE_SECRET` today, so the caller name is only as strong as that secret until per-service keys land; this path has no principal tier or region gate (svc-bank checks the instruction when it is created; identity checks the user is active and not frozen, and the restriction guard still applies).

## Open-order cap

`TRADE_MAX_OPEN_ORDERS` (optional owner integer) caps the resting orders one user holds across all markets; past it a new resting order is `trade.limit_max_open_orders` (422) before any hold. Unset compares nothing, a set-but-invalid value is `trade.max_open_orders_invalid` (503). Operators: `docs/runbooks/trade-pretrade-limits.md`.

## Closed-order history filters

`GET /api/v1/orders/closed` takes `side` (`buy` or `sell`), `status` (CCXT words `closed`, `canceled`, `rejected`, `expired`) and `until` (unix ms, inclusive) next to `symbol`, `limit` and `since`. All filters run in SQL on the caller's own orders, so `limit` stays honest. An unknown `side` or `status`, an `until` that is negative, not a number or before `since` is a 400, never a silent unfiltered page.

## Developer error bodies (DV-errors-01, DV-errors-02)

A create-order body the schema refuses (`POST /api/v1/orders`, each batch item, and `POST /api/v1/orders/:id/replace`) is one 400 that lists every bad field: `code` (CCXT `InvalidOrder`), `intafacedCode`, `message`, `docs` (`/developers/errors#<intafacedCode>`), `errors: [{field, message}]` (one entry per field) and the raw `issues`. One bad field keeps its own code (`trade.invalid_tag` for a tag); more than one is `trade.validation_failed`, whatever order they were reported in. A negative or zero `amount`, `price` or `stopPrice` is listed next to any other bad field in the same reply. Edge stamps `requestId`; this service sets none (`src/create-body-refusal.ts`).

A money call during svc-ledger's platform posting freeze (`ledger.frozen` from the ledger) answers `{code: 'OnMaintenance', intafacedCode: 'posting_frozen'}`, HTTP 503: the freeze lifts on its own and the ledger refused before commit, so the same request (same `clientOrderId`) is safe to resend after a backoff. Nothing is held and no order row is left; reads such as `GET /api/v1/account/balance` still answer. The rename happens in one place, `src/ledger-public-code.ts`, used by the CCXT body, the amend and replace outcomes' `reasonCode` (`REPLACEMENT_NOT_SUBMITTED`) and the tRPC error cause (which stays `BAD_REQUEST`). The account freeze is svc-identity's (`account_frozen`), not this.

## Service keys: ledger calls

The ledger client signs with svc-trade's own key when `S2S_AUTH_MODE`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` are set (`dual` also sends the shared secret, `keypair` the key only); unset, it signs with the shared secret as before. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.

## Service keys: outgoing calls

Every other outgoing call signs with svc-trade's own key too when `S2S_AUTH_MODE`, `S2S_KEYRING`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` are set, each for its callee: svc-identity (approval consume, operator entitlement, rank perks, sub-account ownership, affiliate accrue and payout), svc-matching (every engine call and the position close), svc-fix (drop-copy fill post) and svc-token (OTC stake read). The signature binds method, full URL, body and content type. `dual` also sends the shared secret, `keypair` the key only. Unset leaves the shared secret, exactly as before. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.

## Service keys: inbound doors

The internal doors (market lifecycle publication and read, funding-rate publish, copy-leader fixtures, outcomes settle, closure check) and `/trpc` name the caller from its own service key when `S2S_AUTH_MODE`, `S2S_KEYRING` and the signing pair are set: `dual` accepts the key and the shared secret, `keypair` the key only. Unset, the shared secret works exactly as before. A key-signed call that fails is refused and never retried against the shared secret. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.

## LOCAL TEST tape history

A wiped local stack has no past trades, so charts have no history. `TRADE_LOCAL_TEST_TAPE_RETIME=on` adds `POST /internal/local-test/tape-retime` (body-bound service auth), which spreads a market's TEST trades back over past buckets: the trade at engine sequence position `i` gets `ts = startMs + i * stepMs`, both legs together. The trades themselves are real: the local tooling places them through the normal order path, with ledger holds, engine matches and fees. Only `trade.fills.ts` changes. Prices, quantities, fees, orders, ledger postings and the `trade.fill` events already published keep what they were.

It refuses (typed `trade.local_test_tape_*` errors) unless every fill on the market belongs to orders whose client id starts `LTEST-TAPE-` and that are not seeded, so a live print is never moved and the public tape's sequence order still matches its time order. Times must be in the past and at most 31 days back, with at most 5000 trades per call.

Unset, blank or `off` means the route does not exist. `on` outside an explicit `APP_ENV` of `dev` or `test` stops svc-trade at startup, before it opens the database. Any other value also stops startup. Code: `src/spot/local-test-tape.ts`.
