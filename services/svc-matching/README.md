# svc-matching

**THE ENGINE (§5.1).** Orderbooks and matching. Nothing else.

**What this service is not:** it has no users, no balances, no assets, and no database. It receives orders that
another service has already decided are allowed and already funded, matches them against an in-memory book, and
says what happened. It speaks in **account ids** and quantities. It cannot tell you who owns `acct-7f3a`, what
they hold, or whether they can afford anything — and that ignorance is the design, not a gap in it.

Every input is journalled before it is processed, so replaying the journal rebuilds the exact book the process
died holding (§5.1), and replaying it twice produces byte-identical state (§5.4).

---

## API

HTTP + JSON. Amounts in and out are **decimal strings**, never JSON numbers.

| Route                                        | Input                                                                                                                                      | Output                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /markets/:marketId/orders`             | `{ orderId, accountId, type, side, qty, price?, stopPrice?, tif }` · **svc-trade, svc-execution, or svc-fix**                              | `{ accepted, sequence, fills[], resting, rejected, cancellations[], triggered[] }`                                                                                                                                                                                                                                            |
| `PATCH /markets/:marketId/orders/:orderId`   | `{ expectedVersion, qty?, price?, stopPrice?, tif?, lifecycleProof }`                                                                      | `{ accepted, sequence, version, priority, fills[], resting, rejected }` · native amend, not cancel+new · `404` if not live                                                                                                                                                                                                    |
| `DELETE /markets/:marketId/orders/:orderId`  | — · **svc-trade, svc-execution, or svc-fix**                                                                                               | `{ cancelled, orderId, sequence, cancellation }` · `404` if not live                                                                                                                                                                                                                                                          |
| `POST /markets/:marketId/orders/mass-cancel` | `{ accountId }` · session unsupported                                                                                                      | `{ accepted, accountId, cancellations[], rejected }` · owner is accountId; missing account is 400; session id refuses                                                                                                                                                                                                         |
| `POST /markets/:marketId/mass-quote`         | `{ setId, accountId, bid?, ask?, oneSided?, mmp*, lifecycleProof }`                                                                        | `{ setId, oneSided, results[], rejected }` · two-sided pair (PTX-M11-R11); one side refused unwinds the other; MMP fields may exist but unset magnitudes refuse — never invent 0/qty/delta/vega                                                                                                                               |
| `POST /markets/:marketId/mark`               | `{ mark }` · **service-only**                                                                                                              | `{ accepted, applied, rejected }` · walks the market's trailing stops with a server-side mark; the peak only ratchets and the trigger only tightens, so a repeat or older mark changes nothing; a mark that moved a stop is journaled and replays; blank or zero refuses `missing_mark`; a halted market refuses              |
| `POST /session/dead`                         | `{ sessionId }` · **svc-trade, svc-execution, or svc-fix**                                                                                 | `{ accepted, sessionId, cancellations[], rejected }` · cancel-on-disconnect; tagged rests cancel; new tagged submits refuse; missing session refuses                                                                                                                                                                          |
| `POST /markets/:marketId/halt`               | `{ operatorId, confirmOperatorId }` · **service-only**                                                                                     | `{ accepted, marketId, halted, operatorId, confirmOperatorId, rejected }` · dual-control; missing/same confirm refuses; one market; new submits refuse; cancels stay; no duration                                                                                                                                             |
| `POST /markets/:marketId/resume`             | `{ operatorId, confirmOperatorId }` · **service-only**                                                                                     | `{ accepted, marketId, halted: false, operatorId, confirmOperatorId, rejected }` · dual-control; explicit reopen; halt never expires                                                                                                                                                                                          |
| `POST /halt-all`                             | `{ operatorId, confirmOperatorId }` · **service-only**                                                                                     | `{ accepted, halted, operatorId, confirmOperatorId, rejected }` · dual-control; missing/same confirm refuses; every market; new submits refuse; cancels stay; not one-market halt; no duration                                                                                                                                |
| `POST /resume-all`                           | `{ operatorId, confirmOperatorId }` · **service-only**                                                                                     | `{ accepted, halted: false, operatorId, confirmOperatorId, rejected }` · dual-control; explicit reopen; does not clear one-market halt; never expires                                                                                                                                                                         |
| `POST /markets/:marketId/reduce-only`        | `{ operatorId, confirmOperatorId }` · **service-only**                                                                                     | `{ accepted, marketId, reduceOnly, operatorId, confirmOperatorId, rejected }` · dual-control; missing/same confirm refuses; one market; open/increase refuse; reduce/close/cancel stay; not halt                                                                                                                              |
| `POST /markets/:marketId/reduce-only/resume` | `{ operatorId, confirmOperatorId }` · **service-only**                                                                                     | `{ accepted, marketId, reduceOnly: false, operatorId, confirmOperatorId, rejected }` · dual-control; explicit reopen; never expires                                                                                                                                                                                           |
| `POST /markets/:marketId/post-only`          | `{ operatorId, confirmOperatorId }` · **service-only**                                                                                     | `{ accepted, marketId, postOnly, operatorId, confirmOperatorId, rejected }` · dual-control; missing/same confirm refuses; one market; non-post-only refuse; taking PO still refuses; cancel stay                                                                                                                              |
| `POST /markets/:marketId/post-only/resume`   | `{ operatorId, confirmOperatorId }` · **service-only**                                                                                     | `{ accepted, marketId, postOnly: false, operatorId, confirmOperatorId, rejected }` · dual-control; explicit reopen; never expires                                                                                                                                                                                             |
| `POST /markets/:marketId/prelaunch`          | `{ operatorId, confirmOperatorId }` · **service-only**                                                                                     | `{ accepted, marketId, prelaunch, operatorId, confirmOperatorId, rejected }` · dual-control; missing/same confirm refuses; one market; public submits refuse until OPEN; cancel of nothing is a no-op; not halt                                                                                                               |
| `POST /markets/:marketId/open`               | `{ operatorId, confirmOperatorId }` · **service-only**                                                                                     | `{ accepted, marketId, prelaunch: false, operatorId, confirmOperatorId, rejected }` · dual-control; explicit OPEN; `operatorId` must be the approval's requester and both people must be in `MATCHING_OPERATOR_IDS` (at least two distinct ids, or the service refuses to boot); prelaunch never expires; does not clear halt |
| `POST /markets/:marketId/expire`             | `{ operatorId, confirmOperatorId }` · **service-only**                                                                                     | `{ accepted, marketId, expired, operatorId, confirmOperatorId, rejected }` · dual-control; missing/same confirm refuses; one market; new submits refuse; cancels stay; not halt; no notice period                                                                                                                             |
| `POST /markets/:marketId/delist`             | `{ operatorId, confirmOperatorId }` · **service-only**                                                                                     | `{ accepted, marketId, delisted, operatorId, confirmOperatorId, rejected }` · dual-control; missing/same confirm refuses; one market; new submits refuse; cancels stay; not halt; no notice period                                                                                                                            |
| `GET /markets/:marketId/depth?limit=`        | —                                                                                                                                          | `{ marketId, bids: [price, qty][], asks: [price, qty][] }` · **L2 tuples only**. `?format=l3` does not switch this door. `?format=sbe` is Real Logic octets or `matching.sbe_unavailable` — never JSON as SBE                                                                                                                 |
| `GET /markets/:marketId/depth/sbe`           | —                                                                                                                                          | `application/octet-stream` DepthLevel schemaId 101 · unlinked / utf8 stub → `409 matching.sbe_unavailable` · never JSON bids · `404` if not a market                                                                                                                                                                          |
| `GET /markets/:marketId/depth/l3`            | —                                                                                                                                          | `{ level: 'L3', marketId, bids/asks: [{ price, orders: [{ orderId, remaining, sequence }] }], makerIdentity, l4 }` · native queue, never from L2 · empty queue is empty arrays · `404` if not a market · maker identity and L4 refuse unpublished                                                                             |
| `GET /markets/:marketId/orders`              | — · **service-only**                                                                                                                       | `{ marketId, orders: EngineLiveOrder[] }` · `404` if not a market                                                                                                                                                                                                                                                             |
| `POST /reconcile`                            | `{ orders: CounterpartOrder[] }` · **service-only**                                                                                        | `{ checked, agreed, findings[], refusals, ok }`                                                                                                                                                                                                                                                                               |
| `GET /markets`                               | —                                                                                                                                          | `{ markets, venueHalted, venueHaltedSince, halted, haltedSince, prelaunch, expired, delisted, reduceOnly, postOnly }` · `haltedSince` maps each halted market to when its halt began (ISO), `venueHaltedSince` is null when open; a start with no readable time is left out                                                   |
| `GET /spreads`                               | —                                                                                                                                          | `{ instruments: SpreadInstrument[] }` · owner spread listings (CB-otc-16) · empty when nothing is listed, never a sample instrument                                                                                                                                                                                           |
| `GET /spreads/:spreadId/book?limit=`         | —                                                                                                                                          | `{ spreadId, instrument, bids, asks, sequence, bestBid, bestAsk, lastPrice, ...flags }` · spread-price units, may be negative · `404 spread_unlisted` · blank limit is 400                                                                                                                                                    |
| `POST /spreads/:spreadId/list`               | `{ kind, legs[{ symbol, side, ratio }], tick, lot, operatorId, confirmOperatorId, approvalId, operationId }` · **svc-trade**               | `{ accepted, spreadId, instrument, alreadyListed, operatorId, confirmOperatorId, rejected }` · dual-control approval `matching.spread_list` bound to the exact definition · a blank field refuses typed before the approval is spent · same definition again is a no-op, a different one refuses `spread_listing_conflict`    |
| `POST /spreads/:spreadId/orders`             | `{ orderId, accountId, side, qty, price, tif, anchorReference, clientOrderId?, environment?, sessionId?, lifecycleProof }` · **svc-trade** | same as an order submit; each spread fill carries `legs[{ symbol, takerSide, qty, price }]` · GTC limit only · fills are published on `matching.spread.filled`; an engine built without a publisher refuses `spread_fill_event_unwired`                                                                                       |
| `GET /rulebook`                              | —                                                                                                                                          | `{ published, version }` · blank `MATCHING_RULEBOOK_VERSION` is `{ published: false, rejected: matching.rulebook_unpublished }` · version string only                                                                                                                                                                         |
| `GET /health`                                | —                                                                                                                                          | `{ ok, service, enabled, markets, restingOrders, journalRecords }`                                                                                                                                                                                                                                                            |
| `GET /ready`                                 | —                                                                                                                                          | `503` when the engine is disabled                                                                                                                                                                                                                                                                                             |

Depth and the market list are public — a price is not a secret. The two reconciliation routes are **not**: they
carry order ids and account ids, and an order id is all anyone needs to cancel someone's order.

A **rejection is a 200 with `accepted: false`**, not a 4xx. Post-only refusing to cross is the feature working; a
bot's retry logic must not read it as an outage. Only a malformed body is a `400`.

**Order types** — `limit`, `market`, `stop`, `stop_limit`. **TIF** — `GTC`, `IOC`, `FOK`, `PO` (post-only).
Both come from `@intafaced/exchange-contract`; the engine does not declare its own copy. `take_profit` exists in
the public contract but is a svc-trade concern — it is a stop with inverted trigger semantics, mapped down to
`stop`/`stop_limit` before it reaches here, so the engine keeps exactly one trigger rule.

> **SOCKET §13 — gRPC transport.** §5.1 specifies gRPC, and the Rust port depends on the interface staying narrow.
> The callable surface is `submit`, `cancel`, and native `amend`, already decimal-string in and out. A `.proto` in
> `packages/contracts` plus a thin server in front of the same `MatchingEngine` is the whole change; nothing under
> `src/engine/` moves. That proto is a contracts PR (§15.2) and cannot ship inside a service PR.

---

## Events

**Publishes** — all declared in `packages/events/src/catalog.ts`. This service adds no subject of its own.

Spread fills (CB-otc-16) are **not** `order.filled`: a spread print has a signed price and two legs, and `orderFilled`
would hand svc-trade an outright trade. They go to an injected `SpreadFillPublisher` under the key
`matching.spread.filled:<spreadId>:<sequence>`, which production wires to the catalog subject `spreadFilled`
(`src/spread-fill-publisher.ts`); svc-trade's spread door consumes it. An engine built without a publisher refuses
every spread order `spread_fill_event_unwired` **before** it is journalled — a maker fill nobody announces would
strand that maker's hold. Spread acceptances and cancellations use the normal `order.accepted` /
`order.cancelled` subjects with `marketId` = the spread id.

| Subject                              | When                                           | Idempotency key                                |
| ------------------------------------ | ---------------------------------------------- | ---------------------------------------------- |
| `intafaced.matching.order.accepted`  | an order is admitted (once, at admission)      | `matching.order.accepted:<market>:<orderId>`   |
| `intafaced.matching.order.filled`    | every match                                    | `matching.order.filled:<market>:<sequence>`    |
| `intafaced.matching.order.cancelled` | requested cancel, IOC/market remainder         | `matching.order.cancelled:<market>:<sequence>` |
| `intafaced.matching.order.triggered` | a stop fires (on a trade, an amend or arrival) | `matching.order.triggered:<market>:<sequence>` |

Events for one submission are emitted **in engine-sequence order**, so a consumer reading the subject sees the
order the book applied. The engine sequence is the business key: one fill has one sequence, forever, which is
what makes a JetStream redelivery a no-op rather than a second `tradeFill`.

A stop order emits `order.accepted` **once**, when it enters the stop book. Triggering an hour later does not
emit a second acceptance — it was accepted an hour ago. Its activation shows up as fills and cancellations.

**Consumes** — nothing. Like the ledger, the engine reacts to no one; it is driven by its API and its own journal.

**Recovery emits nothing.** Replaying the journal at boot rebuilds the books silently. Republishing those events
would hand svc-trade a second ledger recipe for a trade that already settled.

---

## Ledger

**This service posts no ledger transactions and holds no balances.** It speaks in account ids only.

| Recipe | Reason code | Accounts |
| ------ | ----------- | -------- |
| _none_ | —           | —        |

That row is the contract. §5.1 draws the boundary — "orderbooks and matching only. No balances, no users" — and
Doctrine §0.6 draws the other half: no module holds its own balance. The money path lives one layer up, in
svc-trade: it takes `ledger.hold` before submitting, turns `order.filled` into the 6-entry `tradeFill` recipe, and
releases the hold on `order.cancelled`. The engine never sees an asset code, a fee, or a user id.

`@intafaced/ledger-client` **is** a dependency, but only its `/money` subpath — `Amount`, `parseAmount`,
`formatAmount`. That is the money _representation_, not the money _path_: prices and quantities are scaled
bigints so the engine and the book agree to 18 decimal places. If a future change here imports a write recipe,
the design has gone wrong; delete the import, not the boundary.

Consequently the tracing helper sets `intafaced.money_path=false` explicitly rather than leaving it unset, so a
trace reader can tell "not a money path" from "someone forgot".

---

## The book

`src/engine/book.ts` is **pure**: no I/O, no async, no clock, no randomness. `submit(order)` is a function of
(book state, order) and nothing else. That is not a style preference — §5.4's determinism requirement dies to any
one of `Date.now()`, `Math.random()`, or iteration over a Map in a way that reaches the output. Price levels are
kept in a **sorted array with binary-search insertion**, not a Map, because a Map iterates in insertion order and
a book whose best price depends on what was inserted first is not a book.

**Price-time priority.** Best bid is the highest price, best ask the lowest; within a price level, orders fill in
arrival order and a partial fill does not lose its place in the queue. A level that empties exactly is removed in
the same pass, so an empty level is never observable as the best price.

**Sequence numbers.** One monotonic counter per book. Every accepted order, every fill, and every cancellation
takes one. A **rejected order takes none** — it never touched the book, and it must leave the counter exactly as
it found it, or a replay of the same inputs would diverge.

**Fill price is always the maker's price.** The taker crossed the spread; it does not also get to set the price it
crossed to.

### Behaviours worth stating plainly

| Case                                   | Behaviour                                                                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Post-only that would cross             | Rejected. No fill, no rest, book untouched — including the sequence counter.                                                                                           |
| FOK that cannot fill completely        | Rejected entirely. Not one unit trades. The check is non-mutating, so nothing is half-done to find out.                                                                |
| IOC with a partial fill                | Fills what it can; remainder cancelled (`ioc_remainder`), never rested.                                                                                                |
| Market order into an empty book        | **Accepted**, zero fills, whole quantity cancelled (`market_remainder`). Uniform with a market order that exhausts the book — the caller releases the hold either way. |
| Market order with `GTC`                | Behaves as IOC. A market order can never rest, whatever TIF it carried.                                                                                                |
| Post-only on anything that cannot rest | Rejected `invalid_tif` rather than reinterpreted.                                                                                                                      |
| Duplicate order id                     | Rejected once the id has been **accepted** (rest, fill, or never-rested take). A 200 retry must not double-live or duplicate-fill.                                     |
| Cancel of an unknown id                | No-op, not an error. A cancel racing a fill is normal.                                                                                                                 |

### Duplicate order ids — what the guard actually covers

Matching HTTP 200 consumes the id. A crash/retry from `svc-trade` after that 200 must not
open a second rest or print a duplicate fill — trade death is not a matching no-op (H8c).
The hold staying on the ledger is the trade half.

The guard is **accepted**, not only **live**: resting, untriggered stop, fully filled, or a
take that never rested. A confirmed cancel forgets the id so it may rest once more (H8e).
Rejected submits (FOK unfillable, post-only would cross) are not consumed — those may be retried.

`book.test.ts` and `h8c.router.test.ts` pin rest retry, fill retry, and snapshot restore.
Caller-side identity in `svc-trade` is still required for holds; it is not the matching
idempotency door.

### Self-trade prevention — expire-resting

When an aggressor would match its own resting order, **the resting order is cancelled** (`self_trade_prevention`) and
the aggressor continues against the remaining book. No self-fill is printed. The engine does not invent a self-fill or
an STP mode list.

FOK viability does not mutate the book and does not count liquidity STP would remove. Missing or different account ids
still match. **No account is ever both maker and taker of the same fill.**

### Stops

A buy stop fires when the market trades **up to** its stop price; a sell stop when it trades **down to** it. Until
the market has printed a price at all, nothing triggers. Activation converts `stop` → market and `stop_limit` →
limit, through the same matcher, and the resting remainder takes its **activation** sequence — a stop that sat for
an hour does not jump the queue when it fires.

Triggers **cascade**: prints from an activated stop can arm the next one. The drain loop terminates because every
pass removes exactly one order from the stop book and nothing puts one back, and it fires the **oldest** armed stop
first — the same tie-break the limit book uses.

---

## Spreads (CB-otc-16)

`src/engine/spread-instrument.ts` and `src/engine/spread-book.ts`. Owner-listed calendar and inter-coin spreads, spot or
futures alike: matching sees symbols and ratios, never margin.

**Listing.** `POST /spreads/:id/list` consumes the same founder dual-control approval as OPEN, with action
`matching.spread_list`, target `spread_list:<id>` and payload fields `{ spreadId, definition }`, where `definition` is
the canonical JSON of the listing (`spreadIdentity`). Every field is owner data: id, kind (`calendar` | `inter_coin`),
exactly two legs (symbol, side from the spread buyer's view, positive ratio), tick and lot. A blank, zero or malformed
field refuses with its own code (`spread_id_missing`, `spread_kind_unsupported`, `spread_legs_invalid`,
`spread_leg_symbol_missing`, `spread_leg_side_missing`, `spread_ratio_missing`, `spread_tick_missing`,
`spread_lot_missing`, `spread_size_inexact`). A calendar trades both legs at the same ratio. The listing is journalled
(`spread_list`) and rebuilt on recovery.

**The book.** One OrderBook per spread, keyed by the spread id. Spread orders rest and match there as one order at a
spread price `Σ (+1 buy | -1 sell) x ratio x leg price`, which may be zero or negative. Outright orders on a spread id
refuse `spread_book_outright_refused`; legs never rest on an outright book. Fill price is the maker's spread price.

**Leg-price rule.** Leg 0 is the anchor and prints at the taker's `anchorReference` (caller data; the engine does not
invent a mark). Leg 1 is the residual and prints at `(S - s0 x r0 x R) / (s1 x r1)`, the one price that makes the
leg prices sum to the spread price exactly. Leg quantities are `fill qty x ratio`. Listing requires `lot x ratio` and
`tick / residual ratio` to be exact at 18 decimals, and admission requires `r0 x R / r1` to be exact, so nothing is
ever rounded.

**Equal or nothing.** Before the journal, the engine refuses a spread when the listing is missing, the spread fill
publisher is unwired, any leg market this engine knows is halted, in maintenance, expired, delisted, in prelaunch or
hold-halted (`spread_leg_unavailable`), the order is off tick or lot, the reference is missing, or any fill the order
would print — rehearsed on a copy of the book — cannot price every leg (`spread_leg_unfillable`). A refusal changes no
book, takes no sequence and writes no journal record. Each accepted fill carries every leg, so svc-trade can take one
hold and post one fill per spread fill.

**Scope.** GTC limit only: IOC, FOK and post-only on spreads are CB-otc-17 and refuse `spread_order_unsupported`.
Native amend refuses `spread_amend_unsupported`; cancel and mass-cancel use the normal market doors with the spread id.
The replay hold check still sizes a resting spread like an outright order; svc-trade's spread hold defines the right
size and that check needs a spread branch when it lands.

## Journal and recovery

`engine_journal` is append-only NDJSON, `fsync`'d per record (`MATCHING_JOURNAL_PATH`). Two properties do all the
work:

1. **Inputs only, never outcomes.** A journal of outcomes would be a transcript: a bug in the matcher would replay
   perfectly while the book stayed wrong. Replaying inputs through the same matcher is what makes the state
   _verifiable_ rather than merely reproducible.
2. **Written before the book moves.** A crash between the two costs at most a re-execution of one input against a
   book rebuilt from the same journal, which lands on the same state. Recovery replays every record exactly once
   into an empty book, then republishes recovered fills with the original sequence idempotency key — it does not
   invent fills. A duplicate-id retry after HTTP 200 is not journaled again. A crash the other way round
   would cost a fill nobody can reconstruct.

Amounts are decimal strings on disk. A journal is read years after it is written, possibly by a process that does
not share this build; a scaled bigint is our private representation, not an archival format.

Snapshots every `MATCHING_SNAPSHOT_EVERY` records (§5.1) via the `SnapshotSink` port. `replayFrom(snapshot, records)`
resumes at `seq > journalSeq` and lands on exactly the state a full replay reaches — there is a test for that.

> **SOCKET §13 — durable journal transport.** `FileJournal` is real durability for a single replica. A replicated
> log (a `matching.engine_journal` table, or a JetStream work queue) drops in behind `EngineJournal`'s three
> methods when the engine goes multi-replica. The Redis snapshot sink for ws-gateway depth streaming lands the same
> way: `SnapshotSink` is one method.

---

A failed write or an ambiguous fsync prevents further admissions on that writer until it closes and recovery reads
the durable prefix. Clean recovery writes and fsyncs a replacement before renaming it over the journal; it also
fsyncs the parent directory. Dead writer recovery serializes through a `.lock.recover` directory. A leftover
recovery directory refuses with `journal_locked`: automatic reclamation cannot safely distinguish an observed
stale directory from a concurrent replacement. A recovery agent or operator can remove it after verifying that no
recovery process owns it, under the existing cleanup authorization.

Native amendments journal the caller's expiry deadline and option identity confirmations alongside the price/quantity
patch. Bracket inputs retain their supplied exit terms and IDs. A refused grouped amendment can still have real fills
or rollback cancellations; those facts publish independently of the group's acceptance. An uncertain mass-quote submit
propagates its original failure when the live book cannot prove acceptance, so callers reconcile the original order/client
IDs rather than treating the error as proof that nothing happened. Historical omitted fields cannot be reconstructed from
journal records that never contained them.

## Reconciliation — the engine and the money have separate lifecycles

The journal is durable and the database is separate, so **the two can disagree and nothing used to notice.** The
books live in memory and come back at boot by replaying `engine_journal.ndjson`; `trade.orders` and the ledger's
`order:<id>` hold accounts live in Postgres. Reset one, and the other keeps its version of events.

Observed on the dev fleet on 2026-08-03, with every health check green: the engine held books for **10 market ids,
not one of which still existed in `trade.markets`**. `trade.orders` was empty, so nothing was stranded — that was
luck, not a property. **The inverse strands user money:** the ledger holds funds for an order the engine has
forgotten, no cancel path will ever fire for it, and the funds are simply unreachable.

### The failure modes, in both directions

`src/reconcile.ts` is a pure function over (what the engine holds, what the caller believes). It is the whole table:

| Case                                  | Engine      | Counterpart       | Verdict    | Why                                                                                            |
| ------------------------------------- | ----------- | ----------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `agreed`                              | live, qty N | open, qty N       | **clean**  | Nothing to say. Amounts compared as parsed amounts, so `2` and `2.000…0` agree.                |
| `counterpart_unfunded_engine_missing` | absent      | pending, unfunded | **auto**   | An intent row nobody funded. Deleting it provably moves no value.                              |
| `counterpart_open_engine_missing`     | absent      | open, **funded**  | **REFUSE** | **The one that strands money.** See below.                                                     |
| `engine_only`                         | live        | unknown           | **REFUSE** | The engine can fill against a hold that does not exist — but the caller's view may be partial. |
| `quantity_disagreement`               | live, qty N | open, qty M       | **REFUSE** | One side mis-tracked a partial fill; the hold no longer matches the exposure.                  |
| `counterpart_terminal_engine_live`    | live        | terminal          | **REFUSE** | Free book risk: a fill would settle against a released hold.                                   |
| `counterpart_pending_engine_live`     | live, qty N | pending, qty N    | **REFUSE** | Intent recorded, not yet opened. Same market and remaining are not agreement.                  |
| `market_disagreement`                 | live in A   | open in B         | **REFUSE** | A cancel sent to either market is aimed at the wrong book.                                     |
| `unreadable_amount`                   | —           | malformed decimal | **REFUSE** | Refuse rather than coerce a number out of it.                                                  |
| `duplicate_counterpart_id`            | any         | same id twice     | **REFUSE** | The caller's view contradicts itself, so no verdict computed from it is trustworthy.           |

**One case auto-resolves. Nine refuse.** That ratio is the design.

### Why the answer is a report and not a repair

The money-stranding case looks like the easy one — the ledger holds funds for an order the engine is not working,
so release them. It is not. **An engine fill whose `order.filled` event was lost produces exactly this shape**, and
in that world the funds are owed to the taker, not back to the user. The two are indistinguishable from the two
states alone; the difference lives in the fills, which this function cannot see and must not guess at. Releasing on
a guess pays a user money the exchange owes someone else.

So reconciliation here **writes nothing, cancels nothing, and moves no value.** It classifies, and where it cannot
resolve without choosing a winner it produces a finding naming the order id and **both** states, which is what an
operator needs and did not have. Silently reconciling a money disagreement is worse than reporting it.

`POST /reconcile` answers **200 with `ok: false`** on a refusal, not a 4xx: a refusal is a correct answer to the
question asked, and a caller polling this must not have to tell "the engine is unreachable" apart from "the engine
found stranded money".

### Reachable and observable

- **`GET /markets/:marketId/orders`** — the non-destructive liveness read. Before it existed, the only way to ask
  the engine "do you still have order X" was `DELETE`: the probe and the repair were the same call, so anything
  that wanted to _look_ had to be willing to _cancel_. `depth()` cannot substitute — it folds a price level into a
  total, so the order ids are gone before a caller sees them. Untriggered stops are included: they never appear in
  depth, and the caller is holding funds for them exactly as if they did.
- **`POST /reconcile`** — the comparison. Give it your view, get the table above back.
- **`GET /health`** carries `restingOrders`, plus `admissionOpen` / `admissionReason` / `holdHalted`.
  A book that replayed resting orders and could not read their ledger holds stays closed: `/ready` is 503 with the
  reason, and submit refuses `hold_check_unreachable`. Liveness stays 200 so the blocker is visible.

Boot reads each resting order's ledger hold (`LEDGER_URL`, `balances` on `order:<id>`, read-only) before it will
match anything. A hold that is missing, smaller than the remaining size, or unreadable is cancelled with reason
`hold_unconfirmed` through the normal cancel path. If that cancel cannot land, the market stays halted
(`hold_unconfirmed`). If the ledger cannot be asked, the market does not open. This service still has no
`DATABASE_URL`. A startup NATS publish that keeps timing out exits non-zero before listen, after a bounded retry
of the same idempotency key. `POST /reconcile` remains the operator report; it is not this boot check.

> **SOCKET §13 — the scheduled cross-service sweep.** `POST /reconcile` is reachable and authenticated, and the
> engine half is done. The caller is not: **svc-trade owns the counterpart view** (`trade.orders` + ledger hold
> balances), and `services/svc-trade/**` is a human mountain (M3/M4, `docs/SHEHZAD-HARD-OWNERSHIP-2026-08-01.md (removed)`).
> Caller landed on svc-trade (A10): `TRADE_RECONCILE_JOBS_ENABLED` default OFF — see `docs/ENGINE-LEDGER-RECONCILE-HANDOFF.md` (removed) §4.4.

---

## Kill-switch

`matching.engine` in the admin console, or `MATCHING_ENGINE_ENABLED=false`.

**Effect when off:** every submission is refused with `engine_disabled` **before it is journalled** — the journal
means "these were processed, in this order", and an input that was never processed does not belong in it. Cancels
and depth reads keep working, so operators can drain a book rather than freeze it. `/ready` returns 503 so the load
balancer takes the instance out of rotation instead of letting every order bounce.

---

## No database

There is no `DATABASE_URL` in this service's env, and the omission is deliberate. §5.1 gives the engine in-memory
books and an append-only journal, and nothing else. A service that demands a connection it never opens is a service
someone will eventually give a table to — and a table here would be a second place trading state lives.

---

## Running it

```bash
pnpm --filter @intafaced/svc-matching build
pnpm --filter @intafaced/svc-matching test
pnpm --filter @intafaced/svc-matching dev
pnpm gate svc-matching
```

## Tests

`book.test.ts` covers the matcher: price-time priority in both directions, queue position across partial fills,
every order type and TIF, self-trade prevention across levels, levels emptying exactly, a multi-level market sweep
checked fill-by-fill and against an exact weighted average, 18-decimal round trips, and a scan asserting the
serialised book contains **no floating-point value anywhere** — every amount is a decimal string, and the only JSON
numbers are integer sequences.

`engine.test.ts` covers the journal-first ordering (including: a journal write that throws leaves the book
untouched), the event contract, recovery republishing fills with the original keys, snapshot cadence, and **§5.4's determinism test** —
~1000 mixed operations across two markets driven by a seeded PRNG, replayed twice, compared as strings. Byte
identity, not deep equality: two different Map iteration orders would pass a deep-equal and still stream different
depth to every client. Three further tests keep that one honest — replay must equal the live engine's state, a
different seed must produce a different book, and the workload must actually fill, rest, and reject rather than
comparing two empty books.

## Service keys: inbound doors

The order, close, basket and surveillance doors name the caller from its own service key when `S2S_AUTH_MODE`, `S2S_KEYRING` and the signing pair are set: `dual` accepts the key and the shared secret, `keypair` the key only. Unset, the shared secret works exactly as before. A key-signed call that fails is refused and never retried against the shared secret. The per-door caller lists (svc-trade; svc-trade, svc-execution and svc-fix for basket children) are unchanged. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.
