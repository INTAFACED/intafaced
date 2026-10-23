# TRK-chain.evm — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `chain.evm`  
**Title:** INTAEVM sharing validator set + state  
**Module / phase:** `chain` · phase **4P** · plane **P**  
**Status on tip:** `ready` · **owner:** none · implement after `chain.mainnet` · Shehzad Tier D  
**Depends on:** `chain.mainnet`  
**Tip freeze:** `origin/main` @ `c7af0849` (re-derive before implement)  
**Pack type:** research only. Agents babysit implement. **Not** “point viem at an L2” alone.

---

## 1 · What “done” means (plain language)

1. An **EVM execution environment (INTAEVM)** is secured by the **same validator set** as INTACORE (§17.1).
2. Builders can deploy **Solidity** against platform liquidity with a shared trust root — EVM module **reads shared chain state** with INTACORE, not a disconnected sidechain.
3. Existing protocol suite artifacts (`SovereignToken`, `TokenFactory`, SA, AMM, …) can target the **INTAEVM chain id** with `launch.status` / chain status reporting that real id.
4. This is **not** satisfied by: configuring `RPC_URL` to Base/Arbitrum, shipping P0 contracts on someone else’s L2, or anvil-only proofs (those are P0 rails / dev — valuable, different tracker).

---

## 2 · Current code state (tip)

### 2.1 EVM client today = external JSON-RPC guest

| Piece                           | Path                                                           | What it is                                                                      |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Read-only chain client          | `services/svc-protocol/src/chain/client.ts`                    | `PublicClient` only — no `WalletClient`, no keys; status never throws when down |
| ABIs                            | `services/svc-protocol/src/chain/abi.ts`                       | SA, pool, token factory, ERC-20 read                                            |
| Availability / zero-addr refuse | `services/svc-protocol/src/chain/availability.ts`              | Fail closed on unconfigured                                                     |
| Deploy tooling                  | `services/svc-protocol/scripts/deploy-dev.ts`, `dev-chain.ts`  | Dev / configured RPC                                                            |
| Launch CREATE2                  | `services/svc-protocol/src/launch/*`                           | Works against **any** configured factory address on that RPC                    |
| AMM / SA                        | `services/svc-protocol/contracts/**`, `src/amm`, `src/session` | Same plane — still external EVM                                                 |

There is **no** EVM module living inside INTACHAIN. There is **no** shared validator set with a native CLOB. There is **no** `svc-chain` EVM ops surface.

### 2.2 What people confuse with this row

| Confusion                                  | Reality                                              |
| ------------------------------------------ | ---------------------------------------------------- |
| “We deploy TokenFactory on Base”           | **P0 rails** (§17.2) — not INTAEVM                   |
| “viem works against our RPC”               | Guest client on someone else’s (or local) chain      |
| “launch.token-factory proven on dev chain” | Template honesty for S-A7 — not shared validator set |
| “chain.evm free craft”                     | Hard-blocked on `chain.mainnet`; Shehzad Tier D      |

### 2.3 Config naming

`packages/config` module `chain` → `svc-chain` (missing). EVM module would be a **component of INTACHAIN**, not a separate Fiat service. Protocol remains the contract lifecycle owner (§17.5).

---

## 3 · Doctrine constraints

| Law            | Implication                                                                            |
| -------------- | -------------------------------------------------------------------------------------- |
| §17.1          | INTAEVM: same validators, read INTACORE state, permissionless deploy against liquidity |
| §17.2 P1       | EVM module ships **with** CometBFT + native CLOB — not before base chain               |
| §21 4P         | INTAEVM listed as part of Protocol P1 mainnet package                                  |
| §0.6 / custody | Platform never holds user keys; protocol builds unsigned ops                           |
| §22            | Permissionless contract use; product gates are API surface, not factory ACL            |
| Shehzad        | Chain module enablement after P0 contracts real (board sequencing)                     |

---

## 4 · Dependency graph

```
matching.engine (done) ──┐
protocol.amm (shehzad) ──┼──► chain.mainnet ──► chain.evm
                         │         │
                         │         ├──► chain.validators
                         │         └──► bridge.canonical (IFC supply)
                         └── P0 EVM suite (already progressing on external rails)
```

INTAEVM enablement is **downstream** of a real INTACHAIN. Parallel work that is allowed: keep P0 contracts honest on chosen rails (S-D1) so the day EVM module lights up, artifacts port cleanly.

---

## 5 · DoD sketch (checkable — staged)

### Stage 1 — after chain.mainnet testnet

- [ ] EVM module enabled on same validator set as INTACORE (documented architecture + chain binary flags).
- [ ] Chain id for EVM domain published; `svc-protocol` config can target it without pretending it is “mainnet L2 X.”
- [ ] Smoke: deploy existing `SovereignToken` / `TokenFactory` artifacts; CREATE2 predict/build still agree.

### Stage 2 — shared state story

- [ ] Documented / proven path for EVM contracts to read INTACORE liquidity or book state (precompile or shared store — **product law**, not agent invent). Observable contract (same block, desync = halt; bridge-attested is **not** the in-block read): [`docs/adr/2026-09-18-intaevm-same-block.md`](../../adr/2026-09-18-intaevm-same-block.md). Implement parked.
- [ ] Indexer / read models know which plane a log came from.

### Stage 3 — builder surface

- [ ] Public docs: how to deploy Solidity against INTAEVM; gas = IFC.
- [ ] `launch.status` reports real chain + `audited` still honest (audit is separate).

**Tracker `done`:** Stage 2 minimum + Stage 1 smoke; not “RPC points somewhere.”

---

## 6 · Gaps

1. No INTACHAIN → no EVM module host.
2. Shared-state rule between CLOB module and EVM is named in S-D2 ([`docs/adr/2026-09-18-intacore-module-map.md`](../../adr/2026-09-18-intacore-module-map.md) §3) and testable in [`docs/adr/2026-09-18-intaevm-same-block.md`](../../adr/2026-09-18-intaevm-same-block.md). Implement still parked.
3. No `svc-chain` ops for dual-execution node.
4. Production factory addresses on INTAEVM — after chain decision.
5. Confusion with P0 multi-chain deploy remains a training/docs risk.

---

## 7 · Risks

| Risk                                         | Mitigation                                         |
| -------------------------------------------- | -------------------------------------------------- |
| Shipping “INTAEVM” label on Base             | Reserve name for shared-validator environment only |
| State desync INTACORE ↔ EVM                  | Design in S-D2 before code                         |
| Agents “implement” by adding another RPC env | Reject PR; wrong mountain                          |
| Audit of templates sold as chain security    | Audits ≠ consensus security                        |

---

## 8 · Estimated size

| Slice                            | Size           | Owner class                           |
| -------------------------------- | -------------- | ------------------------------------- |
| Docs: P0 vs INTAEVM glossary     | **XS** Class N | Agents OK                             |
| EVM module enable + smoke deploy | **L**          | Shehzad / chain after mainnet testnet |
| Shared state reads               | **XL**         | Product law + chain eng               |
| Full builder DX                  | **L**          | After smoke                           |

**First PR size (if free after mainnet testnet):** EVM module enablement + smoke deploy of existing launch artifacts to **that** chain id; `launch.status` reports real chain. **Not** Nitro free craft while mainnet row is vapor.

---

## 9 · Related docs / code

- `INTAFACED_DEFINITIVE_BUILD.md` §17.1, §17.2 P1, §21 4P
- `services/svc-protocol/src/chain/client.ts`, `availability.ts`, `abi.ts`
- `services/svc-protocol/src/launch/` — portable to any EVM once factory deployed
- `docs/ops/trk/chain.mainnet.md`, `launch.token-factory.md`
- Shehzad board Tier D / S-A7

---

## 10 · Explicit non-goals

- No implementing Cosmos EVM module in this research PR.
- No inventing shared-state precompile ABI without Denon/Shehzad.
- No marking chain.evm done because protocol deploys work on anvil.
- No futures/OTC product law.
- No R07/R01 stamp content.
