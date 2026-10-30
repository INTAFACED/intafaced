# svc-indexer

**Chain → Postgres read models for `apps/web` — books, fills, positions (§17.5).**

The Protocol Plane keeps its state on chain, not in our ledger. A UI cannot query a chain fast enough to render an order book, so this service follows chain state and projects it into tables the app can query. It is the read path, and only the read path.

**This service is non-custodial and read-only, and that is structural rather than a policy.** It holds no key, posts no ledger transaction, originates no chain transaction, and has no function anywhere in it that can move a user's funds. `pnpm scan:custody` asserts it on every build (Doctrine §16.10), and `src/sovereignty.test.ts` asserts it again from inside the service.

> **What, structurally, prevents this service from moving a user's funds?**
>
> 1. **It has no key.** `src/env.ts` declares no private key, no mnemonic and no signer, and a test fails the build if that changes. There is no `createWalletClient` and no `privateKeyToAccount` anywhere under `src/`. The one key in this service — anvil's public `test test … junk` mnemonic — lives in `scripts/dev-venue.ts`, and `tsconfig.json` includes only `src/**`, so it is never compiled into `dist/` and the running service cannot reach it. svc-protocol draws the same line in `scripts/dev-chain.ts`.
> 2. **It never writes to the chain.** The only interface it holds against a chain is `ChainSource`, which has exactly two methods and both are reads. The EVM adapter holds a viem `PublicClient` and nothing else, and `src/chain/evm/abi.ts` carries three events and **zero functions** — there is nothing on it to call.
> 3. **It posts nothing to the ledger.** `@intafaced/ledger-client` is reachable from here only through its `/money` subpath — pure decimal arithmetic — and a test asserts that per file. No recipe, no `LedgerClient`, no `ledger.post`.
> 4. **Nothing here is load-bearing for anyone.** Every row in this database is a copy of public chain state. If this service, this database and this company all vanished, every fact it serves would still be readable from any node.

---

## API

Internal tRPC (`createIndexerRouter`), self-mounted at `/trpc` behind `createEdgeContext` per [`docs/decisions/mount-boundary.md`](../../docs/decisions/mount-boundary.md).

**Every data procedure is `publicJurisdictionProcedure('indexer', 'protocol')` — no login, no KYC tier, no account gate.** That is §22 as code: `MODULES.indexer` is `custodial: false` on the `protocol` plane, so `checkAccess` returns `allowed.permissionless`. `src/index.ts` re-asserts it at boot and **refuses to start** if it ever returns anything else.

There is no scoped procedure in this router and there could not usefully be one. Every fact served is a copy of public chain state — the book, the tape, and a position at an address anyone can already query from any node. An account gate in front of a mirror of public data does not protect a user; it only makes the mirror worse than the original.

| Procedure      | Guard          | Input                 | Output                                                                                                                                                                                                                 |
| -------------- | -------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`       | —              | —                     | `{ ok, service, ingestEnabled, clob, chain: { status: 'unprobed', observedChainId: null } }` — liveness, not a custody claim                                                                                           |
| `status`       | permissionless | —                     | cursor, **`behindBy`**, live `chain` probe, **`halted`**, `lastError`                                                                                                                                                  |
| `markets`      | permissionless | —                     | `string[]`                                                                                                                                                                                                             |
| `book`         | permissionless | `{ market, depth }`   | `{ asOfHeight, asOfHash, bids: [price, qty][], asks: … }` — the book as of `status.finalizedHeight`, so it lags the head by `finalityDepth` blocks (`asOfHeight` says which); omit depth is `indexer.book_depth_unset` |
| `fills`        | permissionless | `{ market, limit }`   | recent trades, newest first — omit limit is `indexer.fills_limit_unset`                                                                                                                                                |
| `accountFills` | permissionless | `{ account, limit }`  | an address's tape — omit limit is `indexer.fills_limit_unset`                                                                                                                                                          |
| `position`     | permissionless | `{ market, account }` | signed size + entry price, or `null`                                                                                                                                                                                   |
| `positions`    | permissionless | `{ account }`         | every market that address has a position in                                                                                                                                                                            |

HTTP: `GET /health` (process liveness — does **not** echo `INDEXER_CHAIN_ID` / Anvil 31337; chain is `unprobed`) · `GET /ready`. `status.chain` is the honest probe.

### How stale is this? — the question a read model has to answer about itself

`indexedHeight` alone is worthless. "Height 8412" says nothing without the chain's own tip beside it, and a projection that cannot state its staleness gets trusted at exactly the moment it should not be. So `status` carries three things that are not the cursor:

| Field       | What it is                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `chain`     | A **live** probe, run per request: reachable, observed chain id, the chain's own height, and `venueDeployed` as a real `eth_getCode` |
| `behindBy`  | Chain tip minus cursor. **`null` when either is unknown** — never zero-by-default, because zero reads as "current"                   |
| `lastError` | Why the last pass could not advance, with its typed code. A frozen cursor otherwise looks identical to a healthy idle one            |

`chain` is deliberately live rather than a copy of what the last sync saw: the question is "how stale is this _right now_", and a cached answer to that is a contradiction. `book` still carries `asOfHeight`/`asOfHash`, so a client holding both knows exactly which chain state the ladder in front of it describes.

**`/ready` returns 503 when the book cannot be trusted as live** — a deep-reorg halt, a serving-refuse `lastError` (chain door or startHeight), or a down database. `/health` stays liveness. A load balancer that probes `/ready` must not keep sending traffic at procedures that all 503. Compose healthchecks currently probe `/health`; do not read that as "ready is optional."

**Data procedures refuse on the same signals.** `/ready` only protects callers that go through a load balancer that actually probes readiness. So `book` / `fills` / `accountFills` / `position` / `positions` / `markets` return `SERVICE_UNAVAILABLE` while `status` and `health` keep answering — `status.halted` / `status.lastError` is how a caller learns why. A client that only hits `book` cannot silently render a dead-branch price or an empty book that is really "we never indexed." Transient `indexer.parent_unlink` does **not** refuse: the last canonical projection is still that block.

**Money is a decimal string on the wire and a scaled bigint in memory**, everywhere. `formatAmount` is the only thing in the router that renders a price. Nothing constructs a `number` from an amount: an order book is nothing but sums, and a float sums `0.1 + 0.2` to something that is not `0.3`. There is a test that round-trips 18 decimal places through Postgres and back.

---

## Events

**Publishes — nothing. Consumes — nothing.** This service is not on the bus at all, and its compose entry declares no `nats` dependency for that reason.

That is a deliberate scope line rather than an omission. A `intafaced.indexer.book.updated` subject is an obvious future addition, and adding one is a `packages/events` PR first (§15.2) — the catalog is a contract, and this PR is one service. Until then the read path is pull-only: `apps/web` queries `book` / `fills` / `positions`, and a live feed is the ws-gateway's job (§5.2), fed from the same projection.

What this service does consume is a **chain**, through the `ChainSource` port (`src/chain/source.ts`) — not the event bus.

---

## The chain adapter

`socket.evm-rpc` is **closed**. `src/chain/evm/` is a real adapter against a real JSON-RPC endpoint: real block hashes, real parent links, real logs, real reorg detection. `INDEXER_RPC_URL` selects it; empty selects `NullChainSource` and there is no third state.

### Be precise about what is real

| Real                                                                                  | Still a socket                                                                                 |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The adapter — every line of `evm/source.ts`, proved against a chain that really forks | The **ABI**. No audited venue emits the three events in `evm/abi.ts` — `socket.clob-contracts` |
| Block traversal, hash linkage, log decoding, refusals, the staleness probe            | `contracts/dev/DevVenue.sol` is a **test fixture**: no book, no matching, no access control    |

The adapter does not depend on which events it decodes — swap the ABI and nothing in `source.ts` changes. That split is why `socket.evm-rpc` can close while `socket.clob-contracts` opens: one was an indexer problem, the other is a contracts problem.

### Three decisions worth reading

**Logs are fetched by BLOCK HASH, never by block number.** Reading a header at height N and then logs "at height N" asks about height N twice, and a reorg between the two calls has the node answer both correctly _about two different blocks_ — stapling branch B's logs onto branch A's header. The result is a block that never existed, carrying a hash saying it did, recorded canonical, with nothing left to detect it by. Asking by hash cannot do that. `source.live.test.ts` asserts the shape of the `eth_getLogs` call, because the race itself cannot be staged.

**A failure never comes back as `null`.** `head()` returning `null` means _no chain configured_, and the ingest loop reads that as nothing-to-do. An adapter that swallowed a refused connection into it would be indistinguishable from `NullChainSource`: the cursor would freeze and `book` would keep serving its last projection as current. Every failure is a typed `ChainUnavailableError` instead — `indexer.chain_unreachable`, `indexer.chain_id_mismatch`, `indexer.venue_not_deployed`, `indexer.malformed_block`.

**The venue's code is re-read every pass.** `eth_getLogs` against an address with no contract returns `[]` — not an error, a perfectly formed empty answer, forever. Project that and every read reports an empty book, confidently, about a market that may be busy. It is #210's `suiteDeployed` lesson in its worse form: there a missing contract makes a read _fail_; here it makes a read _succeed with nothing in it_. The dev chain holds no volume, so `docker compose restart evm` genuinely removes the contract while the endpoint and chain id stay put — the exact shape a boot-time check misses.

> **SOCKET §13 — `socket.clob-contracts`.** The event signatures in `src/chain/evm/abi.ts` are declared by this repository and implemented only by a dev fixture. No audited venue contract exists, none is deployed, and `INDEXER_VENUE_ADDRESS` has no honest default — so it is the zero address and `EvmChainSource` **refuses to construct on it**. When the real venue lands, either it emits these signatures or `abi.ts` changes with it; `src/chain/evm/abi.test.ts` is what makes that change simultaneous rather than remembered.

> **SOCKET §13 — `socket.indexer-stream`.** The ws-gateway feed described above. `packages/market-data`'s `diffDepth` already computes the deltas; what is missing is the subject and the transport.

---

## Ledger

**This service posts no ledger transactions and holds no user value. On this plane the user's keys are the only keys.**

There are no recipes to list, because there is no code path here that reaches one.

| Check                                                           | Where                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| No `ledger.post()`                                              | `tooling/ci/custody-scan.mjs`, and again in `src/sovereignty.test.ts` |
| No ledger write recipe, no writable `LedgerClient`              | same                                                                  |
| `@intafaced/ledger-client` reached ONLY via `/money`            | `src/sovereignty.test.ts`, per file                                   |
| No `LEDGER_URL`, no `PRIVATE_KEY`-shaped env var                | `src/sovereignty.test.ts`, over the declarations in `env.ts`          |
| No `createWalletClient` / `privateKeyToAccount` in shipped code | `src/sovereignty.test.ts`                                             |
| Writes reach no schema but `indexer`                            | `src/sovereignty.test.ts`, over the SQL in `postgres-store.ts`        |

### Why this service depends on `ledger-client` at all, when svc-protocol does not

It imports exactly one thing: the `/money` subpath — `parseAmount`, `formatAmount`, `Amount`. That module is pure arithmetic over scaled bigints with no I/O, no client and no recipe, and it is the canonical answer to _"never store money in a `number`"_. `packages/market-data` imports it for the same reason and ships to the browser.

The alternative was a second decimal parser living in this service, which is how two implementations of money end up disagreeing in the last decimal place. `src/sovereignty.test.ts` draws the line where it belongs and checks it per file: **the money subpath is allowed, the root export and the recipes are not.** The root export re-exports `recipes` and `LedgerClient`, so importing it would put the whole write surface one autocomplete away — and `custody-scan` only catches that once someone has already named a recipe.

`ReadOnlyLedgerClient` is permitted on this plane and is **not used**: nothing here needs a fiat-plane balance to answer a question about a chain.

---

## Reorg handling — the part that matters

Chain data is not final on arrival. A projection that applies a block by overwriting the current value **cannot undo it**, because the value it replaced is gone. After a reorg it serves a price that was never on the canonical chain — no error, no gap, no alert. The user just sees a number.

### The option not taken: confirmation depth alone

"Only project blocks that are N deep" is not a reorg strategy, it is a probability knob:

- it makes the read model N blocks stale, always, including the 99.9% of the time when nothing reorgs. For an order book that is the whole product;
- any N is still wrong for a reorg of depth N+1, and the failure mode is unchanged;
- it does not answer the question, it reduces how often the question is asked.

### The option taken: provenance + unwind

Every projected row records the block that wrote it, and the state tables are **versioned by block height** — one row per (key, block) rather than one row per key. "Current" is the newest version.

Repairing a reorg is then `unwindTo(forkHeight + 1)`: **delete the versions above the fork.** The previous version becomes current again by itself. No replay, no compensating writes, no arithmetic that can be off by one — the repair is a `DELETE`.

The projection is therefore correct at every depth, and blocks are projected the moment they are seen. **Confirmation depth survives as what it actually is:** the `prune` retention threshold — the deepest reorg repairable without a full re-index — plus a confidence number on reads. `INDEXER_FINALITY_DEPTH` is operator-set; blank/unset refuse boot. An explicit 64 is that depth.

The detection half is the part everybody skips. An indexer that only ever asks "what is the next block?" will happily extend a branch that no longer exists, because the source keeps answering. So **every pass re-reads the block at our own head and compares hashes before asking for anything newer** — that single extra read is what catches a reorg that replaces the tip without extending it, which is the common shape.

### Proven against a chain that really forks

Every reorg assertion in this service used to be made against `MemoryChainSource` — a fake whose hashes this repository computes and whose forks this repository stages, and which therefore cannot disagree with the code in any way the code did not anticipate. That proves the projection matches the design. It does not prove a chain behaves the way the design assumed.

`src/chain/evm/reorg.live.test.ts` runs the same scenarios against anvil, using `evm_snapshot` / `evm_revert` to make the node **discard blocks it has already published** — blocks this indexer has already read, projected and served. Nothing is staged on our side: the node really does start answering `eth_getBlockByNumber` with a different hash at a height we hold rows for. After the fork, on **both** stores:

- the orphaned level is **gone** — not merged, not left at zero, not sitting under the new level as a rung nobody quoted;
- **one** fill, not two. A tape that kept the orphan would show a trade that never happened, forever;
- the position is the winner's, signed;
- the block at that height is a different block, and the projection says so.

A fork that **replaces the tip without extending it** — the common shape, invisible to any loop that only asks "is there a next block?" — is caught in the same file.

### What is deliberately NOT solved

A reorg deeper than retained history. `findForkPoint` **refuses rather than guesses**: it throws `ReorgTooDeepError`, sets `halted`, and `/ready` starts failing. A reorg that deep is a chain-level event, and the honest responses are "stop serving" and "re-index" — not "guess, and hope the guess is invisible." Now proven on a real chain too, not only a staged one.

### Finality policy, stated

Blocks are projected **the moment they are seen**, at every depth. `INDEXER_FINALITY_DEPTH` is not a confirmation gate — it is the `prune` retention horizon, i.e. the deepest reorg repairable without a full re-index, and the `finalizedHeight` a caller sees on `status`. Blank/unset refuse boot (no silent 64). Below it, superseded versions are collapsed and an unwind is no longer possible; that is the boundary `ReorgTooDeepError` defends. On a chain with instant finality (the dev anvil) any depth is correct; on a probabilistic chain the operator sets it above anything that chain produces.

### Idempotency

Re-processing a block is a no-op **by construction, not by a check someone can skip**:

- **Levels and positions carry absolute state**, never a delta. The upsert is an assignment, so applying it twice reaches the same value. A relative delta applied twice corrupts the level and no primary key can catch it. (A chain that only emits deltas is not excluded — its adapter reduces them to absolute state before yielding a block. That is the adapter's job because it is the part that needs the chain's own state reads.)
- **Fills are keyed on `(block hash, log index)`** — the chain's own identity for a log — with `ON CONFLICT DO NOTHING`. Note _hash_, not height: two competing blocks at one height are different blocks and their fills must not collide.
- `applyBlock` reports `duplicate` but **still performs its writes**. That is telemetry, not control flow: a skip branch would mean the idempotent path is the one that never runs in production, and therefore the one nothing proves.

### The invariant Postgres holds, not the code

```sql
CREATE UNIQUE INDEX blocks_canonical_height_idx
  ON indexer.blocks (chain_id, height) WHERE status = 'canonical';
```

Two canonical blocks at one height means two answers to every read below it, and a bug that produces one is otherwise invisible until a user sees the wrong price. The partial index makes the state unrepresentable — and orphans may still share the height, which is what lets the forensic record be written at all. Orphaned blocks are **kept**, not deleted, and `prune` leaves them too: a projection that silently forgets it ever served a price cannot afterwards explain what a user saw, and the explorer lists a reorged block with its badge.

---

## Schema

`indexer` schema, owned by the `svc_indexer` role, which holds no database-level `CREATE` (§2).

| Table         | Shape                                              | Why                                                                 |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `blocks`      | PK `(chain_id, hash)`, partial unique on height    | Provenance. The only thing that can answer "is this row canonical?" |
| `book_levels` | PK `(chain_id, market, side, price, block_height)` | Versioned levels. Absolute quantity; `0` means empty, not deleted   |
| `fills`       | PK `(chain_id, block_hash, log_index)`             | Append-only tape, keyed by the chain's own log identity             |
| `positions`   | PK `(chain_id, market, account, block_height)`     | Versioned mirror of contract state. Signed size, never a balance    |

Price is `numeric(38,18)` rather than text so that equality is by **value** — `100` and `100.0` are one price level. Every money column is `numeric(38,18)`; there is no float anywhere in the schema, and a test asserts the column types rather than trusting the migration reads that way.

Reversal: `drizzle/0000_indexer_init.down.sql`. It strands nothing — every row here is derived from chain state and is rebuilt by re-indexing. Round-trip proven by `src/projection/postgres-store.test.ts`, which applies every down, asserts the tables are gone, re-applies every up, and asserts they are back.

---

## Tests

`pnpm --filter @intafaced/svc-indexer test` — hermetic suite every run (memory store + mount + sovereignty + always-on chain refusals); Postgres and live-chain suites add more when their deps answer. Every dependency-backed suite skips cleanly when its dependency is unreachable, and **hard-fails on CI**, where `REQUIRE_POSTGRES` and `REQUIRE_EVM_CHAIN` are set. A silently skipped proof is how "we tested the reorg" quietly stops being true. Do not treat a stale headcount in this paragraph as the Done bar — re-run the suite.

| File                                | Covers                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testing/conformance.ts`            | **The shared suite.** Both stores run it unmodified — reorg, idempotency, absolute levels, pruning, kill-switch, ordering, 18-decimal round trip        |
| `projection/memory-store.test.ts`   | The reference store under that suite. No database, so the reorg property is checked on every `pnpm test`                                                |
| `projection/postgres-store.test.ts` | The same suite against real Postgres, plus the partial unique index, the numeric column types, and the migration down/up round trip                     |
| `chain/source.test.ts`              | Port validation — malformed hashes, duplicate log indexes, lossy prices, negative entry prices — and that `MemoryChainSource` hashes deterministically  |
| `chain/evm/decode.test.ts`          | **The money arithmetic, hermetically.** uint256-is-the-Amount, eighteen nines, 10^30, the `numeric(38,18)` bound, market decoding, unknown topics       |
| `chain/evm/abi.test.ts`             | The hand-written ABI against the compiled artefact — signature, topic0, **and the `indexed` flags topic0 agreement does not imply**; artefact integrity |
| `chain/evm/availability.test.ts`    | **Always-on classifiers** — nested `ECONNREFUSED`, `isBlockNotFound`, zero address — no RPC required                                                    |
| `chain/evm/source.unit.test.ts`     | **Always-on refusals** — empty RPC / zero venue refuse construct; dead endpoint `head()` throws `chain_unreachable`, never null                         |
| `chain/evm/source.live.test.ts`     | The adapter on a real chain: parent links, real logs, 18 decimals end to end, address filtering, and every refusal — including the by-block-hash fetch  |
| `chain/evm/reorg.live.test.ts`      | **A real chain, really forked**, on both stores: orphaned rows gone, tip-replacement caught, idempotent restart, deep-fork halt, `behindBy` staleness   |
| `router.mount.test.ts`              | The mount boundary over real `createEdgeContext` headers: anonymous reads succeed, a forged principal confers nothing, `status` surfaces a halt         |
| `d26-p1-i3-done-bar.test.ts`        | **Fastify door** — `GET /ready` 503 with named halt/lastError reason; `GET /trpc/*` refuses dead-branch books (not helper-only)                         |
| `indexer.parent-unlink.test.ts`     | Mid-read parent unlink throws once (`indexer.parent_unlink`) — never burns a green batch with a frozen cursor                                           |
| `ready.test.ts`                     | `/ready` leaves rotation on halt **and** serving-refuse lastError; parent-unlink stays ready                                                            |
| `sovereignty.test.ts`               | §22 for every region × tier with a custodial control, and the §16.10 custody assertions listed under **Ledger**                                         |

**Two implementations is the point.** A single implementation tested against itself proves the tests match the code, not that the code matches the design. The memory store is short enough to check by eye; `unwindTo` is a `DELETE` and `prune` is a `DELETE` with a correlated subquery — the kind of SQL that looks right and is off by one row.

### Mutation testing

The reorg suite was checked by breaking it, four ways. Each mutation was reverted; the numbers are what the run printed.

| Mutation                                                    | Result                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| Disable the "is our head still canonical?" check in `sync`  | **17 failures**, every reorg test in both stores + the halt test |
| `unwindTo` off by one (`> height` instead of `>= height`)   | **10 failures**, both stores                                     |
| Move `quantity > 0` inside the `DISTINCT ON`                | **1 failure**: "removes a level at quantity zero"                |
| Accumulate instead of assign on conflict (levels and fills) | **1 failure**: "re-applying the same block changes nothing"      |

The last two are the interesting ones: a suite that only fails in bulk is not localising anything.

The EVM suites were checked the same way, and the last row is the reason a test exists at all:

| Mutation                                                   | Result                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| Disable the "is our head still canonical?" check           | **6 failures** — every live reorg test on both stores, plus the halt test |
| Remove the `numeric(38,18)` bound in `decode.ts`           | **2 failures**, both in the money section                                 |
| Make `venueDeployed()` always return true                  | **1 failure**: "refuses when the venue address holds no code"             |
| Fetch logs by `fromBlock`/`toBlock` instead of `blockHash` | **0 failures** — until a test was written for it. Now **1**               |

That last mutation is the point of doing this at all. The by-block-hash fetch is the single line standing between a mid-read reorg and a projected block that never existed, and swapping it was a one-line change the entire suite ignored.

---

## Kill-switch

`INDEXER_INGEST_ENABLED=false` at process boot (or a future admin path that calls the in-process `setIngestEnabled` export).

**Honesty note (2026-08-09):** the admin console registry lists `indexer.ingest`, but today that flag is **env-at-boot only** — flipping a chip in admin does not reach the running process. `setIngestEnabled` is exported for that wire; edge/admin have not called it yet. Do not claim a live console toggle until that wire exists.

**Effect when off:** the ingest loop stops advancing; `status.ingestEnabled` reports it. Every read keeps serving what is already projected.

Note what a kill-switch can and cannot do on this plane. It pauses **our** ingestion. It does not stop anyone reading the chain: every fact in this database is public and available from any node. **A kill-switch here is a switch on our convenience, never on a user's access.** A kill-switch that could do more than that would mean this service was load-bearing for someone's funds, and it is not.

---

## Running it

```bash
docker compose up -d                                      # postgres, plus `evm` and `evm-reorg`
pnpm --filter @intafaced/svc-indexer db:migrate           # runs as svc_indexer, which owns the schema
pnpm --filter @intafaced/svc-indexer db:migrate -- --down # and back again — the round trip is real
pnpm --filter @intafaced/svc-indexer test
```

To watch the read model fill up against a real chain:

```bash
docker compose up -d evm
pnpm --filter @intafaced/svc-indexer contracts:build   # only after editing DevVenue.sol
pnpm --filter @intafaced/svc-indexer chain:deploy      # deploys the fixture, prints the three env vars
INDEXER_RPC_URL=http://127.0.0.1:8545 \
INDEXER_VENUE_ADDRESS=0x… INDEXER_START_HEIGHT=… \
  pnpm --filter @intafaced/svc-indexer dev
```

**Two dev chains, and the second is not optional.** `evm` is svc-protocol's, shared. `evm-reorg` (port 8546) exists because `reorg.live.test.ts` deliberately destroys the chain it runs on: `evm_revert` rewinds the whole _node_, so sharing 8545 would rewind svc-protocol's deployed factory out from under its own live tests — and `pnpm verify` runs package tasks in parallel, so "they will not overlap" is not available as an assumption.

Configuration lives in `src/env.ts`: chain id, RPC URL, venue address, start height, finality depth, poll interval, batch size, ingest switch. **There is no key to configure and there never should be** — the one key this service's _tests_ use lives in `scripts/`, which `tsconfig.json` excludes from the build.

**Routed at `svc-edge`** via the `/api/indexer` prefix in `services/svc-edge/src/routes.ts`.
