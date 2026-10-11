# svc-ws

**The live public market-data stream (§5.2 `ws.gateway`).** Depth (snapshot + sequenced deltas) and a public trade
tape, to any browser that asks.

This service owns no users, balances or database. Optional `JWT_ACCESS_SECRET` and
`IDENTITY_OWNERSHIP_SECRET` support authenticated private reads; public `/stream` never uses them. Depth reads a public endpoint
on svc-matching and diffs it with `@intafaced/market-data`. Trades subscribe to the existing `orderFilled` bus
event and re-broadcast a stripped public print.

---

## Why it is its own service

The task was "put a websocket fan-out somewhere". Both obvious homes fail the same test.

**svc-matching** owns the book, which is the argument for it. It also holds `INTERNAL_SERVICE_SECRET`, because it
authenticates order writes — an unauthenticated order submission would let anyone put an unfunded order into the
engine, and the engine's whole design rests on never seeing one. Opening a browser-facing socket there would put the
public internet on the same process as that credential, and would mean adding svc-matching to svc-edge's route
table — a table whose comment says in as many words that svc-matching is deliberately absent.

**svc-trade** is already mounted and already consumes `orderFilled`, which is the better argument. But it **cannot
build a book from those events.** `intafaced.matching.order.accepted` carries `{orderId, marketId, sequence}` and
nothing else (`packages/events/src/catalog.ts`) — no side, no price, no quantity. Widening that payload is a
`packages/events` PR that has to land on its own first (§15.2). So svc-trade would have to poll svc-matching exactly
as this service does, while holding `INTERNAL_SERVICE_SECRET` for both the ledger and the engine and calling
`ledger.hold` on the money path. Attaching an unauthenticated public socket to that process trades the entire
custodial blast radius for one saved container.

The process holds no principal-signing key or database connection. Private reads
use the dedicated identity read credential, configured through
`IDENTITY_OWNERSHIP_SECRET` and matching identity's `IDENTITY_WS_AUTHORITY_SECRET`.
Identity accepts it only for current authority and API-key policy reads. It must
be distinct from generic and admission keys. Public matching/listing reads never
receive that credential.

| Holds                                        | svc-edge | svc-trade | svc-matching | **svc-ws**   |
| -------------------------------------------- | -------- | --------- | ------------ | ------------ |
| `INTERNAL_SERVICE_SECRET`                    | no       | **yes**   | **yes**      | **no**       |
| `EDGE_PRINCIPAL_SECRET`                      | yes      | yes       | no           | **no**       |
| `DATABASE_URL`                               | no       | yes       | no           | **no**       |
| `JWT_ACCESS_SECRET` (private stream only)    | yes*     | no        | no           | **optional** |
| Event bus connection                         | no       | yes       | yes          | **yes***     |
| A ledger client                              | no       | yes       | no           | **no**       |
| Accepts anonymous connections from a browser | yes      | no        | no           | **yes**      |

\*NATS for `orderFilled` only — public print fan-out. Not a money path; order ids never leave the bus-side handler.

The last two rows are the point. This is the second internet-facing process in the fleet, and it is the one with the
least to steal.

**It is not behind svc-edge.** The edge proxy buffers with `response.text()` and its README lists streaming under
"Not built yet", so it cannot carry a socket. Teaching it to would grow the one component whose design goal is the
smallest blast radius in the fleet. A second public origin on a process that holds nothing is the cheaper trade.

---

## API

HTTP + JSON, plus one websocket. Amounts in and out are **decimal strings**, never JSON numbers. The only JSON
numbers anywhere in this service's output are integer sequences.

| Route                                              | Input | Output                                                                                                                                                            |
| -------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /stream?market=<id>` (upgrade)                | —     | `DepthSnapshot`, then `DepthDelta` frames                                                                                                                         |
| `GET /stream?market=<id>&channel=trades` (upgrade) | —     | recent `TradePrint` frames, then live prints                                                                                                                      |
| `GET /drop-copy/stream` (upgrade, JWT)             | —     | independent execution evidence (`drop_copy`) · empty session is `RECOVERY_REQUIRED`, never a complete tape · not `/private/stream`                                |
| `GET /markets/:marketId/depth`                     | —     | `DepthSnapshot` · `404` `MarketNotFound` (unlisted) · `404` `NoBook` (listed, no resting depth) · `502` upstream down                                             |
| `GET /markets/:marketId/trades`                    | —     | recent `TradePrint[]` · `404` `MarketNotFound` (unlisted) · `404` `NoTape` (listed, no prints — never `200 { trades: [] }`) · `502` listing down                  |
| `GET /markets/:marketId/orders`                    | —     | no public blotter · `404` `MarketNotFound` (unlisted) · `404` `NoBlotter` (listed — never `200 { orders: [] }`)                                                   |
| `GET /markets/:marketId/positions`                 | —     | no public blotter · `404` `MarketNotFound` (unlisted) · `404` `NoPositions` (listed — never `200 { positions: [] }`)                                              |
| `GET /markets`                                     | —     | `{ markets: string[] }` — the listing, not the engine's books                                                                                                     |
| `GET /health`                                      | —     | `{ ok, service, enabled, connections, capacity.{depth,trades,private}, tradesBus, privateBus, … }` — occupancy never 503s; ceilings are per-hub, not process-wide |
| `GET /ready`                                       | —     | depth + trade counters + `tradesBus` / `privateBus` / `privateConnections` · `503` only when kill-switch off · bus down does **not** 503 (depth still works)      |

### The wire format is not ours

Frames are exactly `DepthSnapshot | DepthDelta` from `@intafaced/market-data`, unchanged and unextended:

```jsonc
{ "type": "snapshot", "marketId": "BTC-USDT", "sequence": 812, "bids": [["30000.5", "1.25"]], "asks": [] }
{ "type": "delta", "marketId": "BTC-USDT", "fromSequence": 812, "sequence": 813, "bids": [["30000.5", "0"]], "asks": [] }
{ "type": "trade", "marketId": "BTC-USDT", "sequence": 812, "price": "30000.5", "quantity": "0.25", "ts": "2026-07-29T12:00:00.000Z" }
```

Trade frames are `TradePrint` from `@intafaced/market-data`. They are built from `orderFilled` with **order ids
stripped** — maker/taker UUIDs never reach this wire. Aggressor side is not on the event today, so it is not on the
print either (widening `orderFilled` is a separate `packages/events` PR per §15.2).
The server computes deltas with `diffDepth`; the browser applies them with `applyDelta`, which **refuses** any delta
whose `fromSequence` does not match the book it lands on. That refusal is the entire safety property of this
service: a client that misses a frame does not have to be told, it can tell. Every drop policy below leans on it,
which is why none of them may renumber anything.

`quantity: "0"` removes a level. An absent price means unchanged. Those are different statements and conflating them
is how a book grows phantom liquidity.

**A delta is emitted whenever the sequence advances, even when no level changed.** Skipping the empty one would
leave every client behind the engine, and the next real delta would gap and cost the whole fleet a resnapshot.

### The subscription vocabulary is one query parameter

The market is on the upgrade URL and **inbound frames are never parsed**. There is no subscribe verb, no command
set, no JSON parser on the read side, and `maxPayload` is 1 KiB. One market per socket; a terminal that wants two
opens two. On an unauthenticated public port, the smallest possible inbound surface is worth more than multiplexing.

### The snapshot is a separate GET, on purpose

`DepthController` in `apps/web` resnapshots on a gap and must do it **without** tearing down the socket — a
reconnect would lose the deltas that arrive during it, which is the bug its buffer exists to prevent. So the
snapshot is an ordinary `GET`, served from the same book the deltas are diffed against, and the two cannot disagree.
`Access-Control-Allow-Origin: *` with no `Allow-Credentials`: the response carries nothing about the caller, so
"any origin may read this" is a true statement rather than a relaxation, and `*` makes the browser refuse to send
credentials.

---

## Which markets exist — and the outage it caused

**A market id is checked against the LISTING, not against the engine's books.** `TRADE_URL` points at svc-trade's
`GET /api/v1/markets` — the same public, unauthenticated JSON the browser fetches to draw its market picker.
`MATCHING_URL`'s `GET /markets` is unioned in, but it is not the authority: it is `engine.markets`, the books the
engine currently holds.

That distinction was, for a long time, the whole reason live depth did not work. `trade.markets` generates ids with
`defaultRandom()`; svc-matching rebuilds its list by replaying its journal. After a reseed the two had an **empty
intersection** — sixteen listed ids, ten journal ids, nothing in common — so every id a browser could legitimately
discover was refused by the socket with `unknown market`, while both services reported healthy and correct.

A listed market with no book is **not** "a live empty ladder". Six of the sixteen have never traded, and
svc-matching answers 404 for them; `HttpDepthSource` throws `DepthNoBookError` rather than fabricating
`{ bids: [], asks: [], sequence: 0 }`. Empty ≠ zero: the socket stays open with **no snapshot** until matching
has resting depth; the first real quote is a snapshot, not a delta off a fake sequence 0. An id **nobody** lists
is still refused, with `unknown market` — that is the one case that earns a typed close for the market id.

The public **trades** tape follows the same rule. An unseeded ring, a matching 404, or a seed failure is
absence — the socket stays open with **no frames**, and `GET /markets/:id/trades` is `404 NoTape`. Fabricating
`{ trades: [] }` would let a client treat that as a live zero-print market. The first real fill is a `TradePrint`;
prints and mids are never invented.

Private **orders** and **positions** follow the same rule. An unseeded seat, a matching 404, or a seed failure is
absence — no `{ orders: [] }` / `{ positions: [] }` on the wire, and the public GETs are `404 NoBlotter` /
`404 NoPositions`. Fabricating an empty snapshot would let a client treat that as a priced live book of nothing.
The first real lifecycle event is a private update; fills are never invented. Ready frames (`type: "ready"`) name
the bus, they are not a blotter.

The union survives a failure of either source: the listing being down leaves every traded market streaming, the
engine being down leaves every listed market subscribed without a fabricated book, and only a failure of both
keeps the last known list. `depth/registry.ts` carries the reasoning next to the code.

### The thing that would have been a vulnerability

`svc-matching`'s `engine.depth()` used to go through `engine.book()`, which **created the book if it did not
exist** — so a depth read for an arbitrary string was not a 404, it was an allocation in the engine's map, reachable
from any browser that could open a socket here. The engine closed that itself (`existingBook`, plus a 404 on the
depth route), so the market check is no longer the only thing standing between an anonymous socket and svc-matching's
heap. It is still the difference between "nobody is quoting" and "that is not a market", which is why it stays.

There are tests asserting the depth endpoint is never called for an unlisted market, on both the socket and the HTTP
path, and that a listed market with no book stays open without emitting a priced empty snapshot.

There is deliberately **no Origin check**. An origin allow-list is an authorisation control and there is nothing here
to authorise; it would inconvenience a bot without protecting anything, since the same bytes are a `curl` away.
Cross-site WebSocket hijacking is a risk to endpoints carrying ambient credentials. This one carries none.

---

## Backpressure: degrade, then disconnect

A market-data server dies of one of two things — an unbounded per-client queue, or a slow client holding up the
fan-out. **This service keeps no per-client queue at all** once a subscription is live. When a socket's own outbound
buffer is over owner-published `WS_HIGH_WATER_BYTES` (blank refuses `ws.high_water_bytes_unset`; never invent 1048576):

1. **the delta is dropped, not queued.** Dropping is safe here and only here, because the next frame the client
   accepts will not line up and its own gap check fires.
2. **the client is marked lagging.** On the first tick where its buffer has drained it gets a full **snapshot**
   rather than the deltas it missed. The lag sweep runs on **every tick, including ticks where nothing changed**, so
   a client that lagged into a market that then went quiet is still repaired instead of sitting on a book it believes
   is current. That is a specific bug with a specific test.
3. **a client still over the mark after owner-published `WS_MAX_LAG_TICKS` consecutive ticks is disconnected** with
   close code `1013` and a reason. Blank refuses `ws.max_lag_ticks_unset` (never invent 20). Owner may set 20 —
   about five seconds at default poll cadence of a socket that cannot absorb a fifty-level book. That is not a
   trading client.

Replaying missed deltas was the alternative and it is the wrong trade: a replay buffer is unbounded in exactly the
case you need it — a client that is slow _because_ the market is fast — while a snapshot is bounded by
`WS_DEPTH_LIMIT` and repairs any amount of lag in one frame.

The only bounded buffer in the service is the handful of deltas that can arrive between a connection being
registered and its first snapshot being written. It exists for **ordering**, not for loss: without it a delta could
reach the wire before the snapshot and the client would drop it as having no book to apply to.

---

## Snapshot-then-delta ordering

A connection is registered **before** its snapshot is produced. The other order loses every delta that lands in the
gap, and that gap is real — the snapshot is at minimum a turn of the event loop away, and for a cold market it is a
round trip to svc-matching.

Between registration and the first frame, deltas are buffered rather than sent. The snapshot is then taken from the
hub's **current** book at flush time — not from whatever was current when the connection opened — so the buffered
deltas are already inside it and are discarded by sequence. The replay loop after it is a guard on that invariant;
given the current ordering it does not fire, and the test asserts the property (nothing lost, nothing out of order)
rather than the mechanism, by rebuilding the client's book from the frames alone.

The same hazard on the **client** side — an HTTP snapshot in flight while the socket pushes — is genuinely
reachable, and is tested in `apps/web/src/lib/market/ws-transport.test.ts` against a deliberately deferred fetch.

---

## Depth is a top-N window

`WS_DEPTH_LIMIT` (owner-published; blank refuses `ws.depth_limit_unset`; owner may set 50) per side. The snapshot
**and** every delta describe the same window, so a level pushed out of it by deeper liquidity arrives as a removal
and the client's book stays exactly this deep. A client that wants more depth than this is asking for a different
product, not a bigger number.

---

## Why it polls

§5.1 gives the engine no outbound depth feed, and the events it does publish cannot rebuild a book (see "Why it is
its own service"). Adding one is a change to svc-matching — the `SnapshotSink` port in its README is where it would
land — and a change to `packages/events`, which is a separate PR by §15.2.

So: one `GET` per **subscribed** market per tick. A market nobody is watching is not polled, and its book is dropped
when the last subscriber leaves — a book nobody watches goes stale, and a stale book handed to the next connection
as a "snapshot" is a lie with a sequence number on it.

> **SOCKET §13 — push instead of poll.** When svc-matching grows an outbound depth feed (its `SnapshotSink` port, or
> a widened `order.accepted` payload on the bus), `DepthSource` is the seam: two methods, and `DepthHub.ingest` does
> not change. The polling loop in `depth/poller.ts` is the only thing that is deleted.

---

## Events

**Publishes** — nothing. `intafaced.ws.*` does not exist in `packages/events/src/catalog.ts`.

**Consumes** — `orderFilled` for the public trade tape only. Depth still cannot be built from the bus
(`order.accepted` carries no side/price/qty); that half still polls.

| Subject                           | Direction | Notes                                                               |
| --------------------------------- | --------- | ------------------------------------------------------------------- |
| `intafaced.matching.order.filled` | consume   | stripped to `TradePrint` and fan-out; order ids never leave the hub |

---

## Ledger

**This service posts no ledger transactions and holds no balances.**

| Recipe | Reason code | Accounts |
| ------ | ----------- | -------- |
| _none_ | —           | —        |

`@intafaced/ledger-client` **is** a dependency, but only its `/money` subpath — `formatAmount`. That is the money
_representation_, not the money _path_: quantities are scaled bigints in memory so this service and the engine agree
to eighteen decimal places, and decimal strings on the wire. The tracing helper sets `intafaced.money_path=false`
explicitly rather than leaving it unset, so a trace reader can tell "not a money path" from "someone forgot".

If a future change here imports a write recipe, delete the import, not the boundary.

---

## Kill-switch

**How it flips:** `WS_GATEWAY_ENABLED=false` (env + restart), or process `SIGTERM`/`SIGINT` (handler sets enabled
off before close). **Not** via the svc-edge admin console — edge never routes `ws` (this process is a second public
origin, not behind the edge), so edge module halt cannot stop depth/tape here.

**Effect when off:** upgrades are refused with `503`, every open socket is closed with a reason, and `/ready`
returns `503` so the load balancer takes the instance out of rotation. `/health` keeps answering (including per-hub
`capacity` vs the same ceilings attach already enforces), so an operator can still see occupancy without paging.
Occupancy never 503s `/health`.

**Bus honesty:** if NATS subscribe fails **before the first successful attach** (boot), the process **retries with
exponential backoff** (depth keeps serving). `/ready` stays `200` while the bus is down, but `tradesBus` /
`privateBus` are `false` so ops can see an empty tape is not "live and quiet" — it is unsubscribed until the next
successful connect.

After a consumer is attached, **nats.js owns TCP reconnect** for that connection. If the connection is gone for good (`closed()`), `/ready` flips `tradesBus` / `privateBus` false and the lifecycle **re-attaches** without a process restart. Depth keeps serving. Flags are not a continuous probe of remote NATS while TCP reconnect is in progress.

---

## Configuration

| Variable                              | Default                 | Notes                                                                                                                            |
| ------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `HTTP_PORT`                           | `4014`                  | every port 4000–4013 is taken                                                                                                    |
| `MATCHING_URL`                        | `http://localhost:4005` | svc-matching's **read** surface; no credential is sent                                                                           |
| `TRADE_URL`                           | `http://localhost:4004` | svc-trade's public market **listing**; no credential                                                                             |
| `NATS_URL`                            | `nats://localhost:4222` | bus for `orderFilled` trade tape only                                                                                            |
| `WS_DEPTH_LIMIT`                      | _(unset)_               | owner-published levels per side (snapshot and delta); blank refuses `ws.depth_limit_unset` (owner may set 50)                    |
| `WS_POLL_INTERVAL_MS`                 | `250`                   | one GET per subscribed market per tick                                                                                           |
| `WS_MARKETS_REFRESH_MS`               | `30000`                 | market-list cache window                                                                                                         |
| `WS_HIGH_WATER_BYTES`                 | _(unset)_               | owner-published socket buffer above which a client is lagging; blank refuses `ws.high_water_bytes_unset` (owner may set 1048576) |
| `WS_MAX_LAG_TICKS`                    | _(unset)_               | owner-published consecutive lag ticks before disconnect; blank refuses `ws.max_lag_ticks_unset` (owner may set 20)               |
| `WS_MAX_CONNECTIONS`                  | _(unset)_               | owner-published max sockets **per hub**; blank refuses `ws.max_connections_unset` (owner may set 5000)                           |
| `WS_PRIVATE_MAX_CONNECTIONS_PER_USER` | _(unset)_               | private/drop-copy per user; blank refuses `ws.private_max_connections_per_user_unset` (owner may set 16)                         |
| `WS_HEARTBEAT_MS`                     | `30000`                 | ping cadence; a socket that misses a pong is terminated                                                                          |
| `WS_TRADE_RECENT_LIMIT`               | _(unset)_               | owner-published replay while watched; blank refuses `ws.trade_recent_limit_unset` (owner may set 50)                             |
| `WS_DROP_COPY_RECENT_LIMIT`           | _(unset)_               | owner-published drop-copy session replay; blank refuses `ws.drop_copy_recent_limit_unset` (owner may set 50)                     |
| `WS_TRADES_DURABLE`                   | `ws-trade-tape`         | JetStream durable; unique per replica for multi-instance                                                                         |
| `WS_GATEWAY_ENABLED`                  | `true`                  | kill-switch (env / restart / SIGTERM — not edge admin)                                                                           |
| `JWT_ACCESS_SECRET`                   | _(unset)_               | optional; only `/private/stream` — public path ignores it                                                                        |
| `IDENTITY_URL`                        | _(unset)_               | identity authority base; missing/invalid disables private upgrades only                                                          |
| `IDENTITY_OWNERSHIP_SECRET`           | _(unset)_               | dedicated identity private-read key matching `IDENTITY_WS_AUTHORITY_SECRET`; at least 32 characters; no default                  |

### Isolation (what this process holds)

| Credential / secret         | Present? | Why                                           |
| --------------------------- | -------- | --------------------------------------------- |
| `INTERNAL_SERVICE_SECRET`   | **no**   | no S2S writes; depth/listing reads are public |
| `EDGE_PRINCIPAL_SECRET`     | **no**   | public port is not principal-scoped           |
| `DATABASE_URL`              | **no**   | nothing stored here                           |
| `JWT_ACCESS_SECRET`         | optional | private order/fill/position stream only       |
| `IDENTITY_OWNERSHIP_SECRET` | optional | body-signed identity private authority reads  |

Pin: `src/env.isolation.test.ts` + `FORBIDDEN_SERVICE_CREDENTIALS` in `env.ts`.

**How the browser reaches this:** the vendor shell nginx proxies same-origin `/ws/` → `svc-ws:4014/`
(`vendor/upstream-exchange/05_Web_Front/nginx.conf`). Compose: `vendor-shell` on `:8090` depends on `svc-ws`.
Direct `NEXT_PUBLIC_WS_URL` / `apps/web` wiring is not the compose path for the live terminal.

---

## Private stream (`/private/stream`)

JWT-authenticated, push-only. Query `?access_token=` (or `Authorization: Bearer`). Requires `trade:read` or
`trade:write`. Disabled (403) when `JWT_ACCESS_SECRET` is unset; missing/invalid identity
configuration refuses private upgrades with 503. Public depth/tape are unaffected.

Both `/private/stream` and `/drop-copy/stream` require identity POST
`/trpc/accountControls.currentAuthority`, exact plain JSON and body-bound v2 service
authentication. The response must match the verified JWT's user, session/API key
and optional subaccount. API-key IP, origin, product, expiry and account restrictions
remain checked against identity-owned key metadata.

Private authority expires no later than five seconds after request start, and
sooner for remote expiry or JWT expiry. Local elapsed time uses a monotonic clock;
future-skew, stale, mismatched, malformed or unavailable eligibility refuses.
Healthy seats renew halfway through their remaining lease; each identity request
has a one-second timeout. An independent timer closes and terminates expired seats
even while renewal hangs, no private events arrive, or invalidation is missed.
An expired/closed seat cannot revive when a delayed response arrives. Dispatch and
subscription check the lease as well. Ping/pong heartbeat remains transport health;
its 30-second default does not govern authority expiry. Timer deadlines assume the
Node event loop is running; a stalled process cannot provide a real-time bound.

Ordinary production sessions use active identity plus owned live session and
verified JWT scopes. The prior optional passkey adapter expected fields absent
from identity account-state responses; production no longer wires it. Callers
that explicitly supply that supplemental adapter retain its checks. Founder
mutation MFA is checked separately by identity. Read snapshots never authorize
trading admission or new money actions. `/health` and `/ready` report
`privateAuthorityConfigured` as configuration, not a remote availability probe.

On connect the server sends three ready frames, then live updates:

```jsonc
{ "channel": "orders", "type": "ready", "userId": "<uuid>", "bus": true }
{ "channel": "fills", "type": "ready", "userId": "<uuid>", "bus": true }
{ "channel": "positions", "type": "ready", "userId": "<uuid>", "bus": true }
{ "channel": "orders", "fact": "ack", "orderId": "...", /* orderUpdated fields */ }
{ "channel": "orders", "fact": "reject", "status": "rejected", /* ... */ }
{ "channel": "orders", "fact": "cancel", "status": "cancelled", /* ... */ }
{ "channel": "fills", "fact": "fill", "fillId": "...", /* fillSettled fields */ }
{ "channel": "positions", "positionId": "...", /* positionUpdated fields */ }
```

`fact` is the lifecycle discriminator (`ack` / `reject` / `fill` / `cancel` / `expire` /
`unknown`). Presence of an orders frame is not success. Unknown catalog status is
`unknown`, never `ack`. `type` stays limit/market.

`bus: false` means private JetStream consumers are not attached (boot retry still
running, or private subscribe failed). Silence with `bus: false` is **unsubscribed**,
not a quiet market — clients must not treat it as "no orders". `bus: true` and empty
is the honest quiet case.

Matching-down is **named**, not a blank blotter:

```jsonc
{ "type": "status", "code": "orders.engine_unavailable", "channel": "orders", "userId": "<uuid>" }
```

Same `*.engine_unavailable` family as public `depth.engine_unavailable`. A matching
404 / empty blotter stays absence (no `{ orders: [] }` live-zero). `/ready.private.code`
surfaces the same code.

Positions updates are emitted only when `trade.futures` publishes `positionUpdated`. Until then the channel is
mounted and silent — same honesty as REST `GET /positions → []`. Never invent a position frame.

## Not built (outside this service’s Done bar)

- **Mark-driven futures lifecycle on the positions channel.** The positions _socket_ and bus map are
  done (`positionUpdated` fan-out). `trade.futures` already publishes on open/close; non-empty live
  mark/funding frames stay on the trade wall. This service never invents a position frame.
- **Aggressor side on the tape.** `orderFilled` has no side field today. Adding one is a `packages/events` PR
  (§15.2), not a silent invention here.
- **Rate limiting.** There is none anywhere in the platform (svc-edge's README says so too). `WS_MAX_CONNECTIONS` is
  a ceiling, not a rate limit. A failing `GET /markets` is also not rate-limited, so a reconnect storm against a
  down svc-matching costs one upstream call per connection attempt.
- **Horizontal scale.** Each replica keeps its own book per subscribed market and polls independently, so N replicas
  are N times the upstream read load. Fine at this cadence; a shared snapshot sink is the answer when it is not.
- **Compression.** `perMessageDeflate` is off deliberately: a zlib context per socket (~300 KiB at default windows)
  turns "many idle subscribers" — the normal state of a market-data server — into a memory problem, and depth frames
  are small and mostly digits.

---

## Running it

```bash
pnpm --filter @intafaced/svc-ws build
pnpm --filter @intafaced/svc-ws test
pnpm --filter @intafaced/svc-ws dev
pnpm gate svc-ws
```

## Tests

`depth/hub.test.ts` is the one that matters. Almost every assertion goes through a `rebuild()` helper that does
exactly what the browser does — take the snapshot, apply every delta with `applyDelta`, refuse anything that does
not continue — and compares the result to the server's own book. A `fromSequence` that does not line up makes the
rebuild throw. That is deliberate: a test asserting `delta.fromSequence === previous` would pass on a server that
renumbered consistently and shipped a book nobody could rebuild. It covers a 200-tick seeded stream, the connect
window, both backpressure stages, lag repair on a quiet tick, capacity, an engine sequence going backwards, market
isolation, and a scan for JSON numbers where amounts belong.

`ws/gateway.test.ts` runs the same contract over a real TCP socket: snapshot on connect, deltas after, unknown
markets closed with `1008` before any depth call, inbound frames ignored, `400`/`404`/`503` on a refused upgrade,
detach on close, and the HTTP half including CORS and the `502`-not-`500` rule.

`depth/source.test.ts` covers refusing a JSON number where a price belongs, refusing a response with no engine
sequence, and asserting no credential is ever attached to an upstream request.
