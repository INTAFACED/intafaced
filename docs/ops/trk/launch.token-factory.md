# TRK-launch.token-factory — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `launch.token-factory`  
**Title:** ERC-20 deploy from audited templates  
**Module / phase:** `launch` · phase 5 · plane **B**  
**Status on tip:** `ready` · **owner:** none in tracker · implement residual **Shehzad S-A7**  
**Depends on:** none (SA dep **removed 2026-07-30** on evidence)  
**Requires:** `services/svc-protocol/contracts/launch` · `services/svc-protocol/src/launch`  
**Tip freeze:** `origin/main` @ `c7af0849` (re-derive before implement)  
**Pack type:** research only for Nitro agents — **no implement** of protocol contracts. Babysit S-A7.

---

## 1 · What “done” means (plain language)

1. Creator gets **unsigned** deploy calldata for a fixed-supply ERC-20 from a **named, hash-pinned template**.
2. CREATE2 address is **predictable** before broadcast; after broadcast the token **is** the template (supply to recipient only).
3. Template has **no** mint / owner / pause / blacklist / upgrade path (anti-rug base for §35).
4. `launch.status` reports `audited: true` **only** after a real audit package — never sold as live-audited while false.
5. Factory not configured → typed refuse **before** inventing a fictional CREATE2 address against `0x0`.
6. Production factory on a **chosen chain** (S-D1 / product), not “works on anvil” alone.

Title says **audited** — that word is why status stays `ready` despite strong code.

---

## 2 · Current code state (tip)

### 2.1 Contracts (mounted)

| File                                                        | Role                                                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `services/svc-protocol/contracts/launch/SovereignToken.sol` | Fixed-supply ERC-20; entire supply minted once in constructor to named recipient; deliberate absences documented in source   |
| `services/svc-protocol/contracts/launch/TokenFactory.sol`   | CREATE2 factory; salt = keccak(creator, userSalt); params in init code; collision **reverts**; no owner; not payable; no fee |

Pinned suite: solc **0.8.28**, paris; artefacts committed with re-derived `sourceHash`.

### 2.2 Service surface (`svc-protocol`)

| Surface | Path / name             | Behavior                                                                             |
| ------- | ----------------------- | ------------------------------------------------------------------------------------ |
| Status  | `launch.status`         | Template name, sourceHash, **`audited: false` deliberate**, factory configured flags |
| Predict | `predictTokenAddress`   | TS CREATE2 agrees with on-chain `getAddress`                                         |
| Build   | `buildTokenDeployment`  | `src/launch/build.ts` — unsigned calldata only, `value: 0n`                          |
| Info    | `tokenInfo`             | Reads token on chain                                                                 |
| Params  | `src/launch/params.ts`  | decimals 0–18; supply decimal string → scaled bigint; cap `10^20-1` whole            |
| Address | `src/launch/address.ts` | salt, init code, template artifact                                                   |

Custody: service holds **no key**; creator signs and broadcasts (§22 permissionless contract; product gate is API).

### 2.3 Proofs (dev chain)

| Test                                      | Path                                |
| ----------------------------------------- | ----------------------------------- |
| CREATE2 agree / supply / bytecode mask    | `token-factory-onchain.test.ts`     |
| Router end-to-end predict→build→broadcast | `router-launch-live.test.ts`        |
| Unit address / params                     | `address.test.ts`, `params.test.ts` |

Proven: TS CREATE2 matches factory over many creator/salt/param sets; full supply to recipient; no mint/owner/pause/upgrade selectors in deployed bytecode; refuse zero factory before arithmetic (fictional address trap).

**Immutable bytecode gotcha (fixed):** naive `deployedBytecode` compare fails because immutables are spliced — `deployedCodeMatches()` masks compiler immutable ranges.

### 2.4 Explicitly missing for title “audited” / product complete

| Missing                                       | Why it blocks `done`                                   |
| --------------------------------------------- | ------------------------------------------------------ |
| Real audit artifact + `socket.contract-audit` | Title word                                             |
| Production factory address + chain decision   | Dev ≠ product                                          |
| `services/svc-launch` product shell (§8.4)    | Protocol is factory layer only (§17.5)                 |
| Launch fee ledger recipe                      | Fee is Fiat Plane §0.6 — factory not payable by design |
| Instant market / LP                           | Needs trade + `protocol.amm` (meme-factory mountain)   |
| Fuzz / gas snapshots                          | `socket.contract-toolchain`                            |

---

## 3 · Doctrine constraints

| Law          | Implication                                                        |
| ------------ | ------------------------------------------------------------------ |
| §8.4         | Launch product surfaces; factory is contract substrate             |
| §17.5        | `svc-protocol` owns launch factory contracts                       |
| §22          | Permissionless on-chain; product gates at API                      |
| §0.6         | Launch fee = ledger recipe in selling module, not contract balance |
| §35          | Launch trust layer — no rug vectors in default template            |
| Money        | Decimal strings / scaled bigint — never number money               |
| Shehzad S-A7 | Honesty residual on factory                                        |

---

## 4 · Dependency honesty

- **Removed:** `dependsOn: protocol.smart-accounts` — false; launch tests build router with SA factory **ZERO** and still launch.
- **`tokenFactoryDeployed` vs `suiteDeployed`:** separate booleans so neither feature takes the other down.
- Downstream: `launch.launchpad`, `launch.meme-factory`, `launch.nft`, `launch.rwa` (socket) depend on this mountain’s honesty.

---

## 5 · DoD sketch (checkable — staged)

### Stage 1 — already largely true on tip (protocol honesty)

- [x] Fixed-supply template without privilege
- [x] CREATE2 predict/build/broadcast agree on dev chain
- [x] Refuse zero factory
- [x] `audited: false` until real audit
- [ ] Keep proofs green on tip as suite evolves

### Stage 2 — audit + chain decision (S-A7 / S-D1)

- [ ] Audit package lands; status may report audited only with artifact hash
- [ ] Production factory deploy script + env for chosen chain id
- [ ] Never flip audited true without package

### Stage 3 — product shell (may be other rows)

- [ ] `svc-launch` or explicit product owner sells launch + fee recipe
- [ ] UI never claims audited while false

**Tracker `done`:** Stage 2 minimum (audit + real chain factory). Stage 1 alone is **not** title-complete.

---

## 6 · Gaps / residual

1. Audit package absent.
2. Chain decision (which network hosts production factory).
3. No `svc-launch`.
4. No fee recipe.
5. No fuzz/gas sockets filled.
6. AMM seed path blocked on Shehzad M2 (`protocol.amm`).

---

## 7 · Risks

| Risk                           | Mitigation                                      |
| ------------------------------ | ----------------------------------------------- |
| Selling unaudited as audited   | Keep `audited:false`; brand scan / product copy |
| Zero factory fictional address | Already refused — never regress                 |
| Fee in factory contract        | Forbidden §0.6 — keep not payable               |
| Agents implement contracts     | Babysit only; S-A7 / open Shehzad PRs           |
| Number money on supply         | Caps + decimal path already enforced            |

---

## 8 · Estimated size

| Slice                     | Size           | Owner                 |
| ------------------------- | -------------- | --------------------- |
| Keep honesty / docs       | **XS** Class N | Agents                |
| Audit package process     | **M** external | Shehzad + firm        |
| Prod factory deploy + env | **S**          | Shehzad protocol lane |
| Fuzz/gas sockets          | **M**          | Protocol              |
| svc-launch product        | **L**          | Separate mountains    |

**First PR (Shehzad):** production factory deploy script + env; keep `audited:false` until audit. **Nitro agents:** Class N docs only. Do **not** tracker `done` without audit + real chain. Do **not** dual-edit open Shehzad protocol PRs.

---

## 9 · Related docs / code

- Tracker long note on `launch.token-factory` in `features.mjs`
- `services/svc-protocol/contracts/launch/*.sol`
- `services/svc-protocol/src/launch/*`
- `docs/ops/trk/launch.launchpad.md`, `TRK-launch.meme-factory.md`, `TRK-launch.nft.md`
- Shehzad board **S-A7**
- `socket.contract-audit`, `socket.contract-toolchain`

---

## 10 · Explicit non-goals

- No mintable/owner template as silent flag on SovereignToken.
- No fee-on-transfer / rebase templates in this mountain (break AMM invariants).
- No invent product law for raise economics (launchpad).
- No R07/R01 stamp content.
- No claiming done from research.
