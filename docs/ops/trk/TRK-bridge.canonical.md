# TRK-bridge.canonical — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `bridge.canonical`  
**Title:** Canonical IFC bridge + attestations  
**Module / phase:** `bridge` · phase 4P · plane B  
**Status on tip:** ready · **owner:** none (Shehzad board S-B5 design; not free craft invent)  
**Depends on:** `chain.mainnet`, `token.emissions` (emissions done; mainnet not)  
**Requires:** future `services/svc-bridge` (doctrine); **no service on tip**  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. Ledger IFC and chain IFC are **one supply**, reconciled by a **canonical bridge** + attestation path — not two independent print heads.
2. Deposit/withdraw between Fiat ledger and Protocol chain is **attested**, fail-closed, and never invents balances on either side when the other is unreachable.
3. Bridge security model is written (validators / light client / multisig phases) **before** mainnet money moves — no “bridge theatre” contracts without threat model.
4. Operator can see bridge posture (halted / behind / balanced) without a second shadow ledger in analytics.
5. Class X go-live: keys, validator set, counsel — never agent-declared done.

---

## 2 · Current code state (tip)

### 2.1 Nothing to run

| Fact                      | Tip                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `services/svc-bridge`     | **Does not exist** (doctrine tree names it; repo has no package)                                                            |
| Custody scanner exception | `packages/config` modules test notes `svc-bridge` as deliberate future exception shape                                      |
| Depends                   | `chain.mainnet` (INTACHAIN) **not started**; `token.emissions` **done** (mint epoch path)                                   |
| Shehzad board             | **S-B5** — Bridge design (canonical IFC): research + threat model + phased build; “Don’t invent bridge security theater”    |
| Dual-book IFC             | Ledger recipes for IFC exist on Fiat plane; on-chain IFC mint authority / bridge lock is **not** a shipped canonical bridge |

### 2.2 Why this is research-first

Bridges are historically where platforms lose all funds. Spec before code. Agents writing “multisig + optimistic” without Denon/Shehzad direction is exactly the failure mode S-B5 forbids.

---

## 3 · Doctrine constraints

| Law          | Implication                                                                   |
| ------------ | ----------------------------------------------------------------------------- |
| § dual IFC   | Same token two planes; bridge reconciles supply                               |
| §0.6         | Value movement only via ledger recipes on Fiat side; chain side via contracts |
| Dual-book    | Never a balance outside ledger + chain SoT                                    |
| Shehzad S-B5 | Design ownership adjacency — babysit invent                                   |
| Class X      | Mainnet keys, validator ceremony                                              |

---

## 4 · DoD sketch (checkable — staged)

### Stage 0 — design pack (allowed now as docs)

- [x] This research row
- [ ] Threat model: mint/burn vs lock/unlock; reorg; attestation quorum; halt
- [ ] Phased build: dev attestation → testnet → mainnet

### Stage 1 — depends chain.mainnet

- [ ] Bridge contracts + `svc-bridge` attestation service skeleton
- [ ] Fail closed when chain or ledger unreachable
- [ ] Supply conservation tests

### Stage 2 — go-live

- [ ] Class X ops + counsel
- [ ] Public runbook + halt drills

**Tracker `done`:** only after real chain decision + conservation proofs — not anvil demo alone.

---

## 5 · Open questions

1. Mint/burn canonical vs lock/unlock wrapped — product/chain law?
2. Attestation set: same validators as INTACHAIN or separate?
3. Halt authority — who freezes bridge?
4. Relation to pay crypto rails (user deposit) — same or different path?

---

## 6 · Estimated size

| Slice                  | Size          | Notes               |
| ---------------------- | ------------- | ------------------- |
| Threat model doc       | **S** Class N | Shehzad S-B5        |
| Contracts + svc-bridge | **XL**        | After chain.mainnet |
| Go-live                | **Class X**   | Human               |

**First implement PR:** **none from shell agents** until design accepted. Next honest step: S-B5 threat model under Shehzad/Denon direction.

**Human blockers:** chain.mainnet; Shehzad S-B5; Class X.

---

## 7 · Related docs / code

- `docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md` S-B5
- Doctrine bridge / svc-bridge tree
- `token.emissions` / svc-token
- `chain.mainnet` tracker row

---

## 8 · Explicit non-goals for this pack

- No invent bridge contracts “to unblock UI.”
- No second IFC supply on a side chain without reconciliation plan.
- No features.mjs done.
- No dual-edit Shehzad protocol PRs.
