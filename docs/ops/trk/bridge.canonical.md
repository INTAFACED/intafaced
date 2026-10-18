# TRK-bridge.canonical — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `bridge.canonical`  
**Title:** Canonical IFC bridge + attestations  
**Module / phase:** `bridge` · phase **4P** · plane **B**  
**Status on tip:** `ready` · **owner:** none (Shehzad board **S-B5** design; not free craft invent)  
**Depends on:** `chain.mainnet` (not done), `token.emissions` (**done**)  
**Requires:** future `services/svc-bridge` (doctrine); **no service on tip**  
**Tip freeze:** `origin/main` @ `d9e517bd` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; no Shehzad implement; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. Ledger IFC and chain IFC are **one supply**, reconciled by a **canonical bridge** + attestation path — not two independent print heads.
2. Deposit/withdraw between Fiat ledger and Protocol chain is **attested**, fail-closed, and never invents balances on either side when the other is unreachable.
3. Bridge security model is written (validators / light client / multisig phases) **before** mainnet money moves — no “bridge theatre” contracts without threat model.
4. Operator can see bridge posture (halted / behind / balanced) without a second shadow ledger in analytics.
5. Class X go-live: keys, validator set, counsel — never agent-declared done.
6. Halt drills exist; freeze authority is named.

---

## 2 · Current code state (tip)

### 2.1 Nothing to run

| Fact                      | Tip                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `services/svc-bridge`     | **Does not exist** (doctrine tree names it; repo has no package)                                                            |
| Config module             | `packages/config` — `bridge` → `svc-bridge`, planes fiat+protocol, phase 4P, **custodial: true** (the one seam comment)     |
| Custody scanner exception | Config/tests note `svc-bridge` as deliberate future exception shape for dual-plane custody                                  |
| Depends                   | `chain.mainnet` (INTACHAIN) **not started**; `token.emissions` **done** (mint epoch path on token plane)                    |
| Shehzad board             | **S-B5** — Bridge design (canonical IFC): research + threat model + phased build; “Don’t invent bridge security theater”    |
| Dual-book IFC             | Ledger recipes for IFC exist on Fiat plane; on-chain IFC mint authority / bridge lock is **not** a shipped canonical bridge |
| Pay crypto rails          | User deposit/withdraw via pay is a **different** path — do not conflate with IFC supply bridge without product law          |

### 2.2 Adjacent (not a substitute bridge)

| Area                | Path                               | Why not “done” for this title      |
| ------------------- | ---------------------------------- | ---------------------------------- |
| Protocol EVM client | `svc-protocol/src/chain/client.ts` | Contract RPC, not ledger↔chain IFC |
| Token emissions     | `svc-token`                        | Epoch mint path — not bridge       |
| chain.mainnet pack  | `docs/ops/trk/chain.mainnet.md`    | Zero `svc-chain` / CometBFT on tip |
| Indexer             | `svc-indexer`                      | Read models — no custody movement  |

### 2.3 Why research-first

Bridges are historically where platforms lose all funds. Spec before code. Agents writing “multisig + optimistic” without Denon/Shehzad direction is exactly the failure mode S-B5 forbids.

---

## 3 · Doctrine constraints

| Law          | Implication                                                                   |
| ------------ | ----------------------------------------------------------------------------- |
| Dual IFC     | Same token two planes; bridge reconciles supply                               |
| §0.6         | Value movement only via ledger recipes on Fiat side; chain side via contracts |
| Dual-book    | Never a balance outside ledger + chain SoT                                    |
| §17.5        | `svc-bridge` named in doctrine service tree                                   |
| Shehzad S-B5 | Design ownership adjacency — babysit invent                                   |
| Class X      | Mainnet keys, validator ceremony, counsel                                     |
| Money        | Decimal strings / scaled bigint; never invent conservation numbers            |

---

## 4 · Dependency honesty

- **`chain.mainnet`:** blocker for production bridge; interim EVM L2 bridge (if ever product-lawed) is a **different** decision (S-D1 rails ADR) and still not free invent.
- **`token.emissions` done** — does not grant bridge mint authority.
- **S-B5** before Stage 1 contracts.
- Nitro agents: **babysit only** for implement; Class N threat-model docs only under direction.

---

## 5 · DoD sketch (checkable — staged)

### Stage 0 — design pack (allowed now as docs under direction)

- [x] This research row (code-grounded absence)
- [ ] Threat model: mint/burn vs lock/unlock; reorg; attestation quorum; halt; griefing
- [ ] Phased build: dev attestation → testnet → mainnet
- [ ] Relation to pay crypto deposit rails — same or different path (product law)

### Stage 1 — depends chain.mainnet (or explicit interim rails ADR)

- [ ] Bridge contracts + `svc-bridge` attestation service skeleton
- [ ] Fail closed when chain or ledger unreachable
- [ ] Supply conservation tests (both sides)
- [ ] Operator posture API (halted / behind / balanced)

### Stage 2 — go-live

- [ ] Class X ops + counsel
- [ ] Public runbook + halt drills
- [ ] No tracker `done` on anvil-only demo

**Tracker `done`:** only after real chain decision + conservation proofs + Class X go-live path.

---

## 6 · Gaps (named)

1. Entire `svc-bridge` tree.
2. Threat model doc not product-accepted.
3. `chain.mainnet` / rails ADR incomplete.
4. Attestation set design (shared validators vs separate).
5. Halt authority / freeze integration with ops.admin control plane.
6. Counsel / Class X checklist empty for bridge.

---

## 7 · Risks

| Risk                                    | Why it hurts           |
| --------------------------------------- | ---------------------- |
| Bridge theatre without threat model     | Total fund loss class  |
| Two IFC supplies without reconciliation | Dual-book catastrophic |
| Invent multisig params in agent PR      | Security theater       |
| Marketing “bridge live” on dev locks    | User + tracker lie     |
| Dual-edit open Shehzad protocol PRs     | Ownership law fail     |

---

## 8 · Estimated size

| Slice                  | Size          | Notes             |
| ---------------------- | ------------- | ----------------- |
| Threat model doc       | **S** Class N | Shehzad S-B5      |
| Contracts + svc-bridge | **XL**        | After chain/rails |
| Go-live                | **Class X**   | Human + counsel   |

**First implement PR:** **none from shell agents** until design accepted. Next honest step: S-B5 threat model under Shehzad/Denon direction.  
**Human blockers:** chain.mainnet / S-D1; Shehzad S-B5; Class X.

---

## 9 · Related docs / code

- `docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md` S-B5
- Doctrine bridge / `svc-bridge` tree · `packages/config` bridge module
- `token.emissions` / `svc-token`
- `docs/ops/trk/chain.mainnet.md`
- Sister long-form: `TRK-bridge.canonical.md`

---

## 10 · Explicit non-goals for this pack

- No invent bridge contracts “to unblock UI.”
- No second IFC supply on a side chain without reconciliation plan.
- No features.mjs `done`.
- No dual-edit Shehzad protocol PRs.
- No conflating pay crypto rails with canonical IFC bridge without product law.
