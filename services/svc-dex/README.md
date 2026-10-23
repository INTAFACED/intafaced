# svc-dex — the Protocol Plane's front door (§8.6, §17.5)

> §17.5: _"`svc-dex` is absorbed into this plane — the DEX is not a module beside the exchange; it IS the Protocol Plane's front door."_

This process never posts (`custody-scan`). That is not a non-custodial quote: the internal book is custodial, empty `DEX_EXTERNAL_VENUES` is not a live external venue, and ranking is not certified best execution.

## Why there is no KYC here

§503, and it is worth quoting exactly because it is the difference between this and evasion:

> _"Sovereignty by architecture, not evasion. No-KYC exists on the Protocol Plane because there is nothing to KYC — the platform never holds user assets there. Reference proof: Hyperliquid's entire model."_

This is not a relaxed version of the custodial venue. It is a different custody posture, and the absence of an identity gate follows from it rather than being granted.

Three mechanisms make that structural rather than aspirational:

1. **`custody-scan` covers this service.** It fails the build if svc-dex imports `ledger.post` or any write recipe. Doctrine §16.10: _"Provably non-custodial or it doesn't merge."_
2. **No `INTERNAL_SERVICE_SECRET` in its environment.** That secret is what lets a service reach `ledger.post`. Without it, an import that slipped past the scanner still could not move value.
3. **No `DATABASE_URL`.** A database here would eventually hold a position, and a position we hold is custody.

## API contract

| Procedure                                | Access                                               | Purpose                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`                                 | public                                               | GET `/health` and tRPC `health`; names `internalBook.custodial: true`, `externalVenueWired: false` unless operator rows exist, `bestEx.claimed: false`                                                                                                                                                                       |
| `quote`                                  | `publicJurisdictionProcedure('dex','protocol')`      | **live** ranked quotes across sourced venues (not certified best execution)                                                                                                                                                                                                                                                  |
| `routePreview`                           | `publicJurisdictionProcedure('dex','protocol')`      | routing arithmetic over caller-supplied quotes                                                                                                                                                                                                                                                                               |
| `limitOrder`                             | same jurisdiction gate, then the forwarded principal | refuses `dex.order.principal_required` without Edge's principal; a blank price, size, or window refuses; a complete order refuses `dex.order.not_placed` (no vault, no outbound call, no stored session)                                                                                                                     |
| `order.createTrigger` / `order.validate` | same gate, then the forwarded principal              | stores one resting price-trigger order in process memory (buy/sell, above/below). Blank minimum, restricted list, or slippage default refuses. No expiry on a price order refuses `dex.order.expiry_required`. A trigger that would fill now, or a quote under `minOut`, is a warning. The shipped keeper does not broadcast |
| `order.get` / `order.attempts`           | same                                                 | the maker's session reads its order and the keeper's attempt log                                                                                                                                                                                                                                                             |

> `routePreview` **is not a price and must never be rendered as one.** It answers "given these venue quotes, where would the order go?" — useful for a routing explainer or a simulation, and useless as a quote, because the inputs came from whoever called it. It was previously called `quote`, which is precisely how a caller ends up displaying invented numbers in good faith.

`quote` still runs the jurisdiction matrix. **A sanctioned region is a legal constraint, not a custody one** — `checkAccess` short-circuits a `custodial: false` protocol-plane module to `allowed.permissionless` before any tier is read, so the gate that remains is the one that must, and the one that must not is gone.

Compare `svc-trade`, the custodial venue: `scopedProcedure('trade:write')` with `minTier: 'basic'`. Same platform, two planes, and the difference is one line in each router.

## The smart order router

§8.6: _"internal book vs. pool quote → best execution."_

Two venues quoting the same headline price are usually not equivalent. An AMM quote already includes its price impact but pays gas; a book quote is exact at the top and worse as depth is consumed. **Comparing headline prices picks the wrong venue routinely**, so this compares _effective price_ — what the taker actually ends up with after fees and settlement cost.

Fees apply to the side that pays them: a buyer receives less base, raising cost per unit; a seller receives less quote, lowering proceeds per unit. Settlement cost is added on a buy and subtracted on a sell — it is a cost to the taker in both directions and must never look like income.

Requested `qty` and route `qty`/`filledQty` describe planned gross base quantity. A buyer receives that quantity less the base fee; its effective price uses the received quantity. Route leg `quoteAmount` and `totalQuoteAmount` report quote paid on buys and net quote proceeds after fees and settlement on sells. Per-venue `quoteAmount` preserves the gross sourced notional, with fee and settlement disclosed beside it. Ranking and leg amounts share the same integer fee calculation; a rounded per-unit price is never multiplied back into a cash total.

Routing is greedy over per-venue quotes. **Not provably optimal** — a true optimum needs a depth curve per venue, not a single quote. Ties break on venue id so routing is a function of the quote _set_, not of arrival order: two identical requests must route identically, or a fill becomes unreproducible and no dispute about it can be settled.

## Where prices come from

`quote` used to take `quotes: []` over the wire and route whatever the caller supplied. The arithmetic was real; the prices came from nowhere. **A fabricated price in a trading product is worse than an outage**, because an outage stops a user and an invented number encourages one.

A price now enters this service by exactly one road: a `QuoteVenue`, which has to have really fetched a book from something, and has to say when. `QuoteVenue` **extends `LiquiditySource`** from `packages/venue-adapter` — the §27 venue fabric, our own CCXT-class layer — adding only the two things the Fiat Plane router does not model: `settlementCost` (gas) and `depth()` (the book _with_ the moment we read it).

| Venue               | `kind`              | Plane      | Source                  | Status today                                                                  |
| ------------------- | ------------------- | ---------- | ----------------------- | ----------------------------------------------------------------------------- |
| `intachain-clob`    | `external-dex`      | `protocol` | svc-indexer read models | **refuses** — nothing projected (SOCKET §13 `socket.evm-rpc`)                 |
| `internal-book`     | `internal`          | `fiat`     | svc-matching depth      | live wherever the engine has the market                                       |
| operator-configured | `external-cex` etc. | `external` | public depth endpoints  | **empty by default** — not a shipped live venue (`externalVenueWired: false`) |

**No venue is named in shipped code** (Doctrine §0.4 adapters-not-integrations, §0.7 no vendor names). Adding one is a row of `DEX_EXTERNAL_VENUES` config, and the default set is empty — a service with no outbound egress does not silently acquire it.

There is **no `ccxt` dependency and must never be one.** §27 forbids a third-party connectivity library in the money path, and CCXT's unified `fetchOrderBook` returns JavaScript **numbers** — routing through it would put a float in front of every price in the platform. Every adapter reads the venue's own decimal strings and refuses a JSON number outright.

The internal book implements the same interface as everyone else, so **the router has no notion of "ours" versus "theirs" and cannot quietly favour us.** It ranks on effective price alone; there is no internal-preference thumb on the scale anywhere in this service's path.

### Refusal, never a guess

`QUOTE_MAX_AGE_MS` is enforced once, at assembly, against the moment _this process_ finished reading each venue — not a timestamp the venue supplied. Blank / unset refuses (`dex.quote.max_age_unset`) — never invent 2000. Owner-explicit 2000 is allowed. Books are aged against a single clock reading taken after every fetch lands, so a venue answering in 20ms and one answering in 1900ms are not compared as though simultaneous. A book dated in the **future** is refused too: a negative age is a broken clock, not freshness.

There is no cache, no last-known value and no fallback venue. Every exit is a route built from fresh books, or a refusal carrying a machine-readable code:

| Code                              | HTTP                  | Meaning                                                          |
| --------------------------------- | --------------------- | ---------------------------------------------------------------- |
| `dex.quote.no_venue_configured`   | `SERVICE_UNAVAILABLE` | nothing wired — an operator problem                              |
| `dex.quote.no_venue_available`    | `SERVICE_UNAVAILABLE` | no venue answered; the market may be fine, we cannot see it      |
| `dex.quote.stale`                 | `SERVICE_UNAVAILABLE` | answered, but past the freshness ceiling                         |
| `dex.quote.no_liquidity`          | `NOT_FOUND`           | fresh books, nothing resting on the side asked for               |
| `dex.quote.depth_unset`           | `PRECONDITION_FAILED` | `DEX_QUOTE_DEPTH` unpublished — never invent 50                  |
| `dex.quote.max_age_unset`         | `PRECONDITION_FAILED` | `QUOTE_MAX_AGE_MS` unpublished — never invent 2000               |
| `dex.quote.hide_list_unset`       | `PRECONDITION_FAILED` | `OPS_URL` unpublished — no hide list to read, nothing quoted     |
| `dex.quote.hide_list_unavailable` | `SERVICE_UNAVAILABLE` | svc-ops hide list unreachable or malformed — never read as empty |
| `dex.quote.pool_hidden`           | `NOT_FOUND`           | every venue was a pool INTAFACED hides                           |
| `dex.quote.market_hidden`         | `NOT_FOUND`           | INTAFACED hides this market (two founders, svc-ops)              |

### The hide list

Which markets INTAFACED does not list is decided in svc-ops (`protocolListing`, founder approval). `quote` only READS it, from `OPS_URL`, on every request (no cache), after the owner settings and before any venue is read. A list that cannot be read refuses; it is never treated as empty. A hidden pool is dropped from routing: an AMM or external-dex row in `DEX_EXTERNAL_VENUES` names its pool with `pool: { chainId, address }`, and a row without `pool` cannot be hidden by pool (the market delist still applies). If every venue is a hidden pool the quote refuses `dex.quote.pool_hidden`, not "nothing wired". This service holds no platform credential and never writes the list.

### "Best of N" must not mean "the only one that answered"

A cross-venue router degrades quietly by nature: three venues configured, two time out, and the survivor is presented as the best of three. So the response states it — `venuesConfigured` is how many were asked, `venues` is who priced, `unavailable` is who did not **and why**, `degraded` is true when those disagree, and `singleVenue` is true when exactly one survived out of more than one. Ranking honesty is not a certified best-execution claim: `bestEx.claimed` is false until owner law is set.

Every venue also carries `plane` and `custodial`, derived from `kind` rather than configured. A permissionless caller may be quoted our internal book — it sometimes genuinely has the better price — but a fill there settles through the ledger, which is not self-custody. Disclosing that is the difference between an honest quote and a price behind a gate the user was told did not exist.

### Execution is refused, loudly

Every adapter declares `capabilities: ['quote', 'orderbook']` and **throws** on `submit` — not a no-op, not a plausible `status: 'rejected'`. Cross-venue execution is §28 (`svc-execution`, not built) and external venues need trade-scoped Venue Vault credentials (§27) that have not been issued. An execution port that answered plausibly while doing nothing would report fills that never happened.

## Events

**None.** This service publishes and consumes nothing.

## Ledger recipes used

**None, and that is enforced.** See `custody-scan`. If this section ever lists a recipe, the DEX has stopped being a DEX.

## Kill-switch

`dex.routing` in `FLAG_REGISTRY`.

## Not built yet

- **The on-chain leg is opt-in and still does not answer.** `intachain-clob` is attached only when both CLOB fee knobs are set (S-I3). Once attached it refuses with `not_ready` until svc-indexer has projected chain state (SOCKET §13 `socket.evm-rpc`). That refusal _is_ the correct behaviour — the DEX cannot quote the sovereign plane until a chain exists to quote.
- **No AMM venue.** `svc-protocol` now ships a constant-product AMM (`protocol.amm`), but `quoteExactIn` takes **reserves as input** — it is arithmetic, the same shape of gap `quote` just closed. Nothing projects pool reserves: svc-indexer models books, fills and positions, not pools, and there is no EVM RPC to read `getReserves` from. Wiring an AMM venue therefore needs a reserve source first; inventing reserves to make a pool appear in a quote would recreate exactly the defect this PR removed.
- **Order submission on `limitOrder`.** It checks the forwarded principal and refuses a blank price, size, or window. It does not place the order (`dex.order.not_placed`): the wallet session is svc-identity's, the vault is not this process, and every adapter still refuses `submit`.
- **Price-trigger orders are not a balance.** `order.createTrigger` keeps the resting order in process memory under the edge principal. There is still no database and no key. The signature is not recovered here. The shipped price port and fill port are unwired (`feed.market`, `rail.crypto`): the keeper records that and does not broadcast, so a restart cannot double-fill. A restart drops the rows; the vault (not this process) still holds the funds, and the same signed order creates one row again. An `executing` row is only reached when a test or a future port has actually sent; the shipped port never enters it. The attempt log grows with keeper ticks until that restart. The keeper interval is `DEX_ORDER_KEEPER_INTERVAL_MS`; blank does not start it. Minimum size, the restricted-token list, slippage, and oracle max age are blank until the owner publishes them.
- **No rate-limit governor.** §27 asks for one per venue. This adapter fetches on every quote, so a busy market will hit a public endpoint hard enough to be throttled. A venue answering 429 degrades to `unreachable` and is dropped from routing rather than serving a bad price — correct, but a degradation, not a governor.
- **REST polling, not WS streaming.** §27 asks for WS-first, sequenced, gap-detected books. `packages/market-data` already has the sequence machinery; wiring it needs a stream.
- **Latency is graded but not weighted.** `health()` records round-trip per venue and every quote discloses it, so the input exists; nothing consumes it as a routing weight yet.
- **Projection lag is not measured.** `observedAt` catches a slow _read_, not a projection that is up, unhalted and twenty blocks behind the chain. Closing that needs one extra field on svc-indexer's status output.
- **Depth-curve routing.** See above — greedy is deliberate and documented, not accidental.
- **CLOB fees have no silent zero.** SOCKET `socket.dex-fee-source` (S-I3). `DEX_CLOB_FEE_BPS` and `DEX_CLOB_SETTLEMENT_COST` must be set together from the venue, or omitted together — omitted means `intachain-clob` is not quoted. A default of 0 understates the user's cost. Internal-book bps have no default: blank + enabled refuses `dex.internal_book_fee_unset` (never invent 20). The internal book is custodial; every response still discloses `custodial`, `feeBps` and `settlementCost` per venue.
