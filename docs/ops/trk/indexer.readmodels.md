# TRK-indexer.readmodels — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `indexer.readmodels`  
**Title:** Chain → Postgres read models  
**Module / phase:** `indexer` · phase **3P** · plane **P**  
**Status on tip:** `ready` (code largely shipped; residual = venue contracts + stream sockets) · **owner:** none  
**Depends on:** `protocol.smart-accounts` (declared; adapter does **not** need SA for read path)  
**Requires:** `services/svc-indexer`  
**Tip freeze:** `origin/main` @ `d9e517bd` (re-derive before implement)  
**Pack type:** research only — no invent chain data; no keys in indexer; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. UI can read **books, fills, positions** from Postgres projections that track chain state with **reorg unwind**, **idempotent projection**, and honest **staleness** (`behindBy` never zero-by-default).
2. Service remains **non-custodial**: no keys, no ledger posts, custody scan green.
3. Chain half uses real JSON-RPC (not MemoryChain as sole proof); reorg proven on a chain that really forks.
4. When no honest venue contract exists, adapter **refuses** zero address / missing code — never serves a confident empty book for a busy market.
5. Stream feed to ws-gateway is either real or absent (socket) — not a fake tick stream.
6. Permissionless read API via edge `/api/indexer`.

---

## 2 · Current code state (tip)

### 2.1 Largely complete on tip

`services/svc-indexer` is mounted at edge `/api/indexer`. Config: `indexer` → `svc-indexer`, protocol plane, phase 3P, non-custodial.

| Capability                                 | State                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Schema-per-service read models             | **Yes** — books, fills, positions                                                         |
| Block-versioned rows + reorg unwind        | **Yes** — live anvil reorg tests                                                          |
| Idempotent projection                      | **Yes** — fresh Indexer applies 0 blocks on re-run                                        |
| Permissionless /trpc read API              | **Yes**                                                                                   |
| Real EVM adapter (`socket.evm-rpc` closed) | **Yes** — viem PublicClient, logs by **block hash**                                       |
| Staleness probe                            | **Yes** — live tip, `behindBy` null when unknown, never zero-by-default                   |
| Sovereignty / no key                       | **Yes** — structural tests                                                                |
| Test mass                                  | Tracker notes ~132 tests (hermetic + Postgres + live anvil) — re-count on tip before cite |

### 2.2 Design decisions already in code (do not unlearn)

1. **Logs by block hash**, not number — a reorg between header-read and log-read must not staple branch B logs onto branch A header.
2. **Failure never returns null** for chain source — dead endpoint must not look like `NullChainSource`.
3. **Venue code re-read every pass** — `eth_getLogs` against absent contract returns `[]` forever (suiteDeployed lesson in worse form).
4. **Money:** on-chain uint256 with 18 implied decimals **is** the scaled bigint Amount; `Number()` never touches amounts; amounts ≥ 10^38 refused (`numeric(38,18)`).
5. **viem getBlockNumber memoisation** was a real bug (staleness lying) — tests pin the fix.

### 2.3 Residual that blocks tracker `done`

| Socket / gap                | Meaning                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **`socket.clob-contracts`** | ABI events implemented only by `contracts/dev/DevVenue.sol` fixture — no audited venue; `INDEXER_VENUE_ADDRESS` zero refuses construct |
| **`socket.indexer-stream`** | ws-gateway feed subject/transport not productized                                                                                      |
| Compose default             | Still no chain in default compose — operator must set RPC + venue                                                                      |

**This is a contracts / product residual, not “rewrite the indexer.”** Agents must not claim done by pointing at DevVenue.

### 2.4 Tracker note

The long tracker note is **mostly still accurate** (chain half real; residual venue). Prefer re-derive test counts and socket ids on tip before implement.

---

## 3 · Doctrine constraints

| Law           | Implication                                         |
| ------------- | --------------------------------------------------- |
| §17.5         | Indexer is read path for protocol state             |
| Non-custodial | No keys ever in svc-indexer                         |
| Money amounts | uint256 18dp = scaled bigint; no `Number()`         |
| Fail closed   | Dead RPC ≠ empty book; missing venue code ≠ success |
| Shehzad       | Venue contracts adjacency — babysit invent          |
| Dual-book     | Indexer never posts ledger                          |

---

## 4 · Dependency honesty

- Declared dep `protocol.smart-accounts` is **loose** for pure read path — SA not required to project venue events.
- Real residual for “done” is **venue contracts** (protocol / Shehzad runway) + optional stream socket.
- Related: `dex.quote-router` consumes honest quotes — not a substitute for venue event emissions.

---

## 5 · DoD sketch (checkable — staged)

### Stage 1 — honesty (now)

- [x] Research pack records residual = venue contracts + stream socket
- [x] Adapter refuses zero venue / proves reorg on real fork
- [ ] Do not flip tracker `done` on DevVenue alone

### Stage 2 — venue contracts (protocol / Shehzad)

- [ ] Audited or product venue emits events (or ABI updates with simultaneous tests)
- [ ] Non-zero venue address in non-prod with real code
- [ ] Close `socket.clob-contracts` with proof

### Stage 3 — stream socket

- [ ] indexer → ws-gateway subject + transport; no fabricated ticks
- [ ] Close `socket.indexer-stream` or split to separate tracker row

**Tracker `done`:** Stage 2 minimum (honest venue) + existing adapter proofs. Stream may be split later.

---

## 6 · Gaps (named)

1. No audited CLOB venue emitting the three events in `evm/abi.ts`.
2. Default compose still no chain.
3. Stream to ws-gateway not productized.
4. Mainnet RPC provider Class X ownership.
5. Possible ABI change when real venue lands (force simultaneous tests).

---

## 7 · Risks

| Risk                                  | Why it hurts                   |
| ------------------------------------- | ------------------------------ |
| Marking done against DevVenue         | Users trust empty “live” books |
| Inventing depth in projections        | Dual-book / market lie         |
| Keys in indexer “for convenience”     | Custody scan + doctrine fail   |
| Null on RPC failure                   | Empty book sold as truth       |
| Logs by block number after reorg race | Wrong fills stapled            |

---

## 8 · Estimated size

| Slice                   | Size     | Notes                   |
| ----------------------- | -------- | ----------------------- |
| Indexer residual polish | **S**    | Only if real bugs found |
| Venue contracts         | **L–XL** | Not indexer package     |
| Stream socket           | **M**    | After venue truthful    |

**First implement PR for _indexer_ residual:** usually **none** — wait venue. Optional S: stream design doc or subject contract-only PR.  
**Human blockers:** `socket.clob-contracts`; `socket.indexer-stream`; venue ownership often Shehzad-adjacent.

---

## 9 · Related docs / code

- `services/svc-indexer/README.md`
- `services/svc-indexer/src/chain/evm/` · ABI · reorg live tests
- `socket.clob-contracts` / `socket.indexer-stream` §13
- Edge route `/api/indexer`
- DevVenue fixture honesty
- Sister long-form: `TRK-indexer.readmodels.md`

---

## 10 · Explicit non-goals for this pack

- No marking done against DevVenue alone.
- No inventing venue depth in projections.
- No adding keys to indexer “for convenience.”
- No features.mjs `done` from research.
- No Shehzad venue invent under this pack.
