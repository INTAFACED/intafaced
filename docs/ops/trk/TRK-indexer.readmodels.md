# TRK-indexer.readmodels — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `indexer.readmodels`  
**Title:** Chain → Postgres read models  
**Module / phase:** `indexer` · phase 3P · plane P  
**Status on tip:** ready (code largely shipped; residual = venue contracts socket) · **owner:** none  
**Depends on:** `protocol.smart-accounts` (declared; adapter does not need SA for read path)  
**Requires:** `services/svc-indexer`  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. UI can read **books, fills, positions** from Postgres projections that track chain state with **reorg unwind**, **idempotent projection**, and honest **staleness** (`behindBy` never zero-by-default).
2. Service remains **non-custodial**: no keys, no ledger posts, custody scan green.
3. Chain half uses real JSON-RPC (not MemoryChain as sole proof); reorg proven on a chain that really forks.
4. When no honest venue contract exists, adapter **refuses** zero address / missing code — never serves a confident empty book for a busy market.
5. Stream feed to ws-gateway is either real or absent (socket) — not a fake tick stream.

---

## 2 · Current code state (tip)

### 2.1 Largely complete on tip

`services/svc-indexer` is mounted at edge `/api/indexer`. README + tracker note document:

| Capability                                 | State                                           |
| ------------------------------------------ | ----------------------------------------------- |
| Schema-per-service read models             | **Yes** — books, fills, positions               |
| Block-versioned rows + reorg unwind        | **Yes** — live anvil reorg tests                |
| Idempotent projection                      | **Yes**                                         |
| Permissionless /trpc read API              | **Yes**                                         |
| Real EVM adapter (`socket.evm-rpc` closed) | **Yes** — viem PublicClient, logs by block hash |
| Staleness probe                            | **Yes** — live tip, behindBy null when unknown  |
| Sovereignty / no key                       | **Yes** — structural tests                      |

### 2.2 Residual that blocks tracker `done`

| Socket / gap                | Meaning                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **`socket.clob-contracts`** | ABI events implemented only by `DevVenue.sol` fixture — no audited venue; `INDEXER_VENUE_ADDRESS` zero refuses construct |
| **`socket.indexer-stream`** | ws-gateway feed subject/transport not productized                                                                        |
| Compose default             | Still no chain in default compose — operator must set RPC + venue                                                        |

**This is a contracts / product residual, not “rewrite the indexer.”** Agents must not claim done by pointing at DevVenue.

---

## 3 · Doctrine constraints

| Law           | Implication                                         |
| ------------- | --------------------------------------------------- |
| §17.5         | Indexer is read path for protocol state             |
| Non-custodial | No keys ever in svc-indexer                         |
| Money amounts | uint256 18dp = scaled bigint; no Number()           |
| Fail closed   | Dead RPC ≠ empty book; missing venue code ≠ success |
| Shehzad       | Venue contracts adjacency — babysit invent          |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — honesty (now)

- [x] Research pack records residual = venue contracts + stream socket
- [ ] Tracker note stays long-form honest (already is); do not flip done on DevVenue

### Stage 2 — venue contracts (protocol / Shehzad)

- [ ] Audited or product venue emits events (or ABI updates with simultaneous tests)
- [ ] Non-zero venue address in non-prod with real code

### Stage 3 — stream socket

- [ ] indexer → ws-gateway subject + transport; no fabricated ticks

**Tracker `done`:** Stage 2 minimum (honest venue) + existing adapter proofs. Stream may be split row later.

---

## 5 · Open questions

1. Will real venue keep current three-event ABI or force abi.ts change?
2. Is stream part of this mountain or separate socket forever?
3. Mainnet RPC provider Class X ownership?

---

## 6 · Estimated size

| Slice                   | Size     | Notes                   |
| ----------------------- | -------- | ----------------------- |
| Indexer residual polish | **S**    | Only if real bugs found |
| Venue contracts         | **L–XL** | Not indexer package     |
| Stream socket           | **M**    | After venue truthful    |

**First implement PR for _indexer_ residual:** usually **none** — wait venue. Optional S: stream design doc or subject contract-only PR.

**Human blockers:** socket.clob-contracts; socket.indexer-stream; Not blocked.

---

## 7 · Related docs / code

- `services/svc-indexer/README.md`
- `socket.clob-contracts` / `socket.indexer-stream` §13
- DevVenue fixture honesty
- edge route `/api/indexer`

---

## 8 · Explicit non-goals for this pack

- No marking done against DevVenue alone.
- No inventing venue depth in projections.
- No adding keys to indexer “for convenience.”
- No features.mjs done from research.
