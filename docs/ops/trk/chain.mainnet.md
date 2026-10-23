# TRK-chain.mainnet — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `chain.mainnet`  
**Title:** INTACHAIN — CometBFT + native CLOB module  
**Module / phase:** `chain` · phase **4P** · plane **P**  
**Status on tip:** `socket` — **P1 implement parked 2026-09-03** ([`docs/adr/2026-09-03-protocol-rails-until-intachain.md`](../../adr/2026-09-03-protocol-rails-until-intachain.md)). Owner **shehzad002**. Do not implement until Nitro GO.  
**Depends on:** `matching.engine` (**done**) · `protocol.amm` (**ready**, owner **shehzad002** — not done)  
**Requires:** future `services/svc-chain/` (doctrine §17.5) — **absent on tip**  
**Tip freeze:** `origin/main` @ `c7af0849` (re-derive before implement)  
**Pack type:** research / spec only. **No implement** by Nitro agents. No `features.mjs` edit. No money invention. No vapor `status:done`.

---

## 1 · What “done” means (plain language)

1. A real **INTACHAIN** network exists that is not anvil theatre sold as mainnet: Cosmos SDK / CometBFT app-chain with a **native CLOB module** (price-time priority, tick/lot rules aligned with Fiat Plane `svc-matching`).
2. **IFC** is gas + staking security asset on that chain (§17.3); security budget is real bond/slash design — not APY marketing.
3. One-block finality (or published SLO if softer) is **documented and measured** on testnet, then mainnet.
4. Node ops path lives under `services/svc-chain/` (config, genesis tooling, validator runbooks) — doctrine names this service; tip has **zero** of it.
5. Public chain id + honest labels: testnet never marked tracker-`done`; mainnet `done` only with live CLOB fill path proven, not “binary boots.”

---

## 2 · Current code state (tip)

### 2.1 Absent services (named in doctrine, not in tree)

| Doctrine (§17.5)        | Tip                                                                            |
| ----------------------- | ------------------------------------------------------------------------------ |
| `services/svc-chain`    | **Does not exist**                                                             |
| `services/svc-bridge`   | **Does not exist** (bridge.canonical separate pack)                            |
| `services/svc-indexer`  | **Exists** as Fiat/protocol read models residual — not CometBFT module indexer |
| `services/svc-protocol` | **Exists** — P0 EVM contracts on configured RPC, **not** app-chain             |

`packages/config` already names module `chain` → service `svc-chain`, plane protocol, phase 4P, non-custodial — config is aspirational until the service lands.

### 2.2 What _is_ on tip (adjacent, not this mountain)

| Area                              | Path                                             | Relevance                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fiat matching (dual-target later) | `services/svc-matching/`                         | Done engine; narrow submit/cancel surface intended to share **matching spec** with INTACORE CLOB module (§17.2 P2); engine has **no** chain awareness today |
| Protocol EVM rails                | `services/svc-protocol/`                         | Contracts + read-only `PublicClient` (`src/chain/client.ts`); deploy via `scripts/deploy-dev.ts` / configured RPC                                           |
| AMM dep                           | `services/svc-protocol/contracts/amm`, `src/amm` | Tracker `protocol.amm` owner **shehzad002** — hard dep not done                                                                                             |
| Smart accounts                    | `services/svc-protocol` SA suite                 | P0 rails; not INTACHAIN consensus                                                                                                                           |
| Dev chain                         | `services/svc-protocol/scripts/dev-chain.ts`     | Local EVM for contract proof — **not** mainnet                                                                                                              |

### 2.3 Tracker honesty

- `chain.mainnet` has no `status: done` and no `owner` field — free for research; implement is Shehzad Tier D.
- Default status in tracker is `ready` when omitted.
- Dep `matching.engine` is **done**; dep `protocol.amm` is **not** — sequencing: P0 contract honesty before P1 app-chain.

**Tip residual:** zero CometBFT binary, zero genesis, zero CLOB module, zero public chain id for INTACHAIN. Protocol plane today = **contracts on a configured EVM JSON-RPC**.

---

## 3 · Doctrine constraints

| Law                     | Implication                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| §17.1                   | INTACORE + INTAEVM end state — this row is INTACORE mainnet path                                                 |
| §17.2 P0 → P1 → P2 → P3 | P0 contracts on proven rails **first**; P1 CometBFT+CLOB; P2 Rust core; P3 validator open + governance           |
| §17.3                   | IFC gas + staking security; bridge unifies supply later                                                          |
| §17.5                   | `svc-chain` owns node ops / validator tooling / chain config                                                     |
| §21 phase 4P            | Protocol P1: INTACHAIN mainnet — native CLOB, INTAEVM, IFC gas+staking, bridge live (bridge is separate tracker) |
| §5.1 matching           | Fiat engine and INTACORE share matching **spec**; Rust port is `socket.rust-matching`                            |
| Agent protocol          | No invent consensus params / validator economics / slash rules without Denon direction                           |
| Class X                 | Mainnet keys, go-live, operator geo — human                                                                      |

---

## 4 · Shehzad board mapping (implement babysit only)

| Board id | Scope                                           | Relation to this row                                             |
| -------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| **S-D1** | P0 rails ADR (which L2 / HyperEVM / anvil-only) | **Prerequisite decision** — without it, “mainnet” is fantasy     |
| **S-D2** | INTACORE module map (spec)                      | CLOB-at-chain, margin, finality SLOs as targets                  |
| **S-D3** | Validator / staking architecture                | Feeds `chain.validators`; security vs `token.stakeOf` separation |
| **S-D4** | CometBFT / app-chain residual                   | **This tracker row** — phased milestones, not vapor done         |

Board home: `docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md`.

---

## 5 · DoD sketch (checkable — staged)

### Stage 0 — law (docs only; this pack class)

- [ ] S-D1 written: P0 rails chain id(s) + what is **not** sold as INTACHAIN.
- [x] S-D2 module map: CLOB module responsibilities vs Fiat `svc-matching` / `svc-trade`. Law: [`docs/adr/2026-09-18-intacore-module-map.md`](../../adr/2026-09-18-intacore-module-map.md). Implement still parked until Nitro GO.
- [ ] Explicit “not mainnet” labeling standard for any local/testnet binary.

### Stage 1 — testnet skeleton (after S-D1 + product go)

- [ ] `services/svc-chain` skeleton: config schema, genesis **testnet**, docs “permissioned / not mainnet.”
- [ ] CometBFT (or chosen stack) boots; chain id public in runbook.
- [ ] No tracker `done`.

### Stage 2 — native CLOB module (dual-spec)

- [ ] Module implements price-time priority + tick/lot aligned with `packages` exchange-contract / matching journal concepts.
- [ ] Fill path proven on testnet (submit → match → observable fill) without inventing mid.
- [ ] Journal/replay story or equivalent determinism proof for chain module.

### Stage 3 — mainnet bar

- [ ] Public mainnet chain id + IFC gas + published security model (bonds).
- [ ] CLOB fill path on mainnet; SLO published.
- [ ] Ops runbooks under `svc-chain`; incident path for halt.

**Tracker `done`:** Stage 3 only. Local anvil / dev-chain RPC **never** qualifies.

---

## 6 · Gaps (named)

1. Entire `svc-chain` tree.
2. App-chain source (Cosmos SDK modules / CometBFT config) — not in monorepo.
3. Bridge (`svc-bridge`) for ledger↔chain IFC — separate mountain `bridge.canonical`.
4. Product law: consensus params, fee distribution on chain, who runs genesis validators (Denon / Class X).
5. `protocol.amm` unfinished — dep honesty.

---

## 7 · Risks

| Risk                                | Why it hurts                                                 |
| ----------------------------------- | ------------------------------------------------------------ |
| Marketing “mainnet” on P0 L2 deploy | Lies to users; confuses tracker `done`                       |
| Invent slash / bond numbers         | Class X / security economics; agents must not invent         |
| Dual-book drift                     | Fiat matching and chain CLOB diverge → arbitration nightmare |
| Premature status:done               | Residual campaign treats vapor as shipped                    |
| Parallel agents implementing chain  | Human-owned Tier D — babysit only                            |

---

## 8 · Estimated size

| Slice                                | Size             | Notes                 |
| ------------------------------------ | ---------------- | --------------------- |
| S-D1 rails ADR                       | **S** Class N    | Denon/Shehzad product |
| S-D2 module map                      | **M** docs       | Spec-heavy            |
| svc-chain skeleton + testnet genesis | **L**            | Shehzad / chain eng   |
| Native CLOB module v1                | **XL**           | Multi-PR program      |
| Mainnet go-live                      | **XL + Class X** | Keys, ops, counsel    |

**First engineering PR after law:** skeleton `svc-chain` + testnet genesis with explicit not-mainnet labels. **Not** Nitro free craft while S-D\* / M2 own runway.

---

## 9 · Related docs / code

- `INTAFACED_DEFINITIVE_BUILD.md` §17.1–17.5, §21 phase 4P
- `docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md` Tier D
- `services/svc-matching/README.md` — dual-target intent
- `services/svc-protocol/src/chain/client.ts` — current EVM-only access
- `packages/config/src/modules.ts` — `chain` → `svc-chain`
- Downstream packs: `chain.evm.md`, `chain.validators.md`, `chain.governance.md`, `TRK-bridge.canonical.md`

---

## 10 · Explicit non-goals for this pack

- No invent futures/OTC/perp product law on chain.
- No marking tracker done from research.
- No implementing `svc-chain` in a Nitro agent PR under this pack.
- No conflating protocol contract deploys on Base/Arbitrum/anvil with INTACHAIN mainnet.
- No R07/R01 stamp content.
- No dual-edit of open Shehzad protocol/AMM PRs.
