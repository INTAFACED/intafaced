# TRK-chain.validators — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `chain.validators`  
**Title:** Validator set opening, published schedule  
**Module / phase:** `chain` · phase **5P** · plane **P**  
**Status on tip:** `ready` · **owner:** none · implement **Shehzad S-D3** + progressive decentralisation §17.2 P3  
**Depends on:** `chain.mainnet`  
**Tip freeze:** `origin/main` @ `c7af0849` (re-derive before implement)  
**Pack type:** research only. Agents babysit implement. Class X on who may operate.

---

## 1 · What “done” means (plain language)

1. Validator membership is not “the house runs three boxes forever” with no public story.
2. A **published schedule** opens the set: dates, eligibility criteria, stake thresholds, application path.
3. **IFC staking** secures the chain (real security budget: bond, downtime/slash rules) — not APY theatre and not a rebrand of product `token.stakeOf`.
4. Public can verify who produces blocks and how to join (or why they cannot yet).
5. Decentralisation is a **dated roadmap**, not a marketing word (§17.2 P3).

---

## 2 · Current code state (tip)

### 2.1 Nothing chain-validator-shaped

| Expected                               | Tip                                   |
| -------------------------------------- | ------------------------------------- |
| `services/svc-chain` validator tooling | **Missing** (service absent)          |
| Genesis validator set                  | **None**                              |
| Bonding / slash module                 | **None**                              |
| Published schedule artifact with force | **None** (this pack is not the force) |

### 2.2 Fiat / product stake (deliberately different)

| Piece                          | Path                                           | Role                                                                |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------- |
| Access tiers + `token.stakeOf` | `services/svc-token/src/economics/staking.ts`  | Gates launchpad tiers, vendor slots, OTC access — **product gates** |
| Identity rank `launchpadTier`  | `services/svc-identity/src/rank/thresholds.ts` | Mirror rank benefits — not CometBFT bonding                         |
| Ledger IFC balances            | `services/svc-ledger` + recipes                | Custodial plane balances                                            |

**Critical honesty (S-D3):** ledger/product stake and chain security stake must **not** double-count or silently become the same number without an ADR. Today they are separate systems because the chain does not exist.

### 2.3 Config

`packages/config` names `chain` → `svc-chain` (future home for validator tooling per §17.5).

---

## 3 · Doctrine constraints

| Law          | Implication                                                                         |
| ------------ | ----------------------------------------------------------------------------------- |
| §17.2 P3     | Validator set opens on published schedule; governance takes parameter control later |
| §17.3        | IFC staking secures validators — real security budget                               |
| §21 phase 5P | Protocol P2–P3: Rust core, **validator opening**, governance handover schedule      |
| §4.3         | Governance is IFC-weighted (ballot lives in svc-token; outcomes socketed)           |
| Class X      | Who may run validators; geo/sanctions on operators; mainnet keys                    |
| Shehzad S-D3 | Architecture for security stake vs stakeOf                                          |

---

## 4 · Relationship to other mountains

| Id                          | Relation                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `chain.mainnet`             | Hard dep — no validators without a chain                                            |
| `chain.governance`          | Handover of params after validators exist; depends on this row + `token.governance` |
| `token.staking` (done)      | Product stake only until S-D3 binds or permanently separates                        |
| `token.governance` (socket) | Ballot for later param control — not validator admission                            |
| `bridge.canonical`          | IFC supply continuity across planes                                                 |

---

## 5 · DoD sketch (checkable — staged)

### Stage 1 — schedule + economics ADR (docs)

- [ ] Published schedule draft: T0 permissioned set, T+N application window, T+M permissionless criteria (owner-approved numbers only).
- [x] S-D3 ADR: how IFC bonding works; explicit non-equivalence (or careful equivalence) with `token.stakeOf`. Law: [`docs/adr/2026-09-18-validator-stake-vs-stakeof.md`](../../adr/2026-09-18-validator-stake-vs-stakeof.md) (**non-equivalence**; magnitudes still owner-blank; implement parked).
- [ ] Slash / downtime policy labeled as product law, not agent invent.

### Stage 2 — testnet permissioned set

- [ ] Genesis validator config in `svc-chain` for testnet.
- [ ] Explicit label: “permissioned set; open date T+N.”
- [ ] Public list of testnet operators (or house-only with honesty statement).

### Stage 3 — open schedule fires

- [ ] Application / bonding path live.
- [ ] Public can verify set membership on-chain or via attested API.
- [ ] Never claim permissionless before schedule date.

**Tracker `done`:** Stage 3 on mainnet path, or product explicitly cuts “open” and rewrites title — do not leave title implying open while forever house-only without note.

---

## 6 · Gaps

1. No chain binary / genesis.
2. No bonding module design beyond doctrine sentences.
3. No schedule document with legal/ops force.
4. No operator KYC/geo policy (Class X content).
5. No bridge story for staked IFC if dual-plane.

---

## 7 · Risks

| Risk                                   | Notes                                                       |
| -------------------------------------- | ----------------------------------------------------------- |
| Conflating stakeOf with validator bond | Users think product stake secures chain — it does not today |
| Invent slash percentages               | Security economics = Denon/Shehzad/Class X                  |
| Premature “decentralised” copy         | Brand/doctrine violation                                    |
| Empty schedule that never fires        | Same as marketing word                                      |
| Agents implementing genesis alone      | Shehzad lane; babysit                                       |

---

## 8 · Estimated size

| Slice                      | Size                 | Notes                       |
| -------------------------- | -------------------- | --------------------------- |
| Schedule draft + S-D3 ADR  | **S–M** Class N/docs | First honest slice          |
| Testnet genesis validators | **M**                | After chain.mainnet Stage 1 |
| Bonding module + open path | **XL**               | Chain eng + Class X         |
| Ops runbooks               | **M**                | `svc-chain`                 |

**First PR (if free):** docs only — published schedule draft + bonding economics ADR with owner-approved numbers. Code later: genesis validator config for testnet with permissioned honesty.

---

## 9 · Related docs / code

- `INTAFACED_DEFINITIVE_BUILD.md` §17.2 P3, §17.3, §21 5P
- `docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md` **S-D3**
- `services/svc-token/src/economics/staking.ts` — product tiers only
- `docs/ops/trk/chain.mainnet.md`, `chain.governance.md`
- Fiat stake ≠ chain security until S-D3 says otherwise in writing

---

## 10 · Explicit non-goals

- No inventing slash rates, min bond, or max set size in agent PRs.
- No wiring `token.stakeOf` to CometBFT without ADR.
- No claiming permissionless set before schedule fires.
- No futures risk / M3 product law under this id.
- No R07/R01 stamp content.
