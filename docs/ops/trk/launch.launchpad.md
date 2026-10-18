# TRK-launch.launchpad — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `launch.launchpad`  
**Title:** Presale / fair launch, vesting, staked allocation tiers  
**Module / phase:** `launch` · phase 5 · plane **F** (product surface) with Protocol intersections  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `launch.token-factory` (ready, not done) · `token.staking` (**done**)  
**Tip freeze:** `origin/main` @ `c7af0849` (re-derive before implement)  
**Pack type:** research only. Agents do **not** invent raise economics / refund / dispute law. On-chain vesting/escrow intersects Shehzad (**S-A7 expand**, **S-G2**, escrow).

---

## 1 · What “done” means (plain language)

1. A project configures **presale or fair-launch** terms with honest contribution settlement.
2. Contributions settle via **ledger recipes** (Fiat) and/or **contracts** (Protocol) — never spreadsheet theatre.
3. **Vesting** is enforced (contract or ledger-locked schedule), not a UI countdown over free balance.
4. **Allocation caps / windows** respect `token.stakeOf` tiers already defined in svc-token (`launchpadAllocationTier`).
5. Fail closed when factory, chain, or stake service unavailable — never invent fill of a raise.
6. House raise fee (if any) is a disclosed ledger recipe (§0.6).

---

## 2 · Current code state (tip)

### 2.1 Product service missing

| Expected                  | Tip                                                                              |
| ------------------------- | -------------------------------------------------------------------------------- |
| `services/svc-launch`     | **Does not exist**                                                               |
| Config module `launch`    | `packages/config` → `svc-launch`, planes fiat+protocol, phase 5, custodial: true |
| Raise / vesting contracts | **None** dedicated under launchpad                                               |
| Contribution recipes      | **None** in `packages/ledger-client/src/recipes/`                                |

### 2.2 Stake gating data — ready for consumers

| Piece                     | Path                                                                                  | Values (tip)                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Access tiers              | `services/svc-token/src/economics/staking.ts`                                         | Base 0 · Initiate 1k · Operator 10k · Architect 100k · Sovereign 1M IFC minStake |
| `launchpadAllocationTier` | same                                                                                  | 0…4 ascending with stake                                                         |
| Identity rank mirror      | `services/svc-identity/src/rank/thresholds.ts` · `packages/contracts` `launchpadTier` | Rank benefits mirror — not raise engine                                          |

**No code** currently enforces allocation caps on a raise — only tier numbers exist.

### 2.3 Token factory (upstream partial)

| Piece       | Path                      | Launchpad use                                          |
| ----------- | ------------------------- | ------------------------------------------------------ |
| Deploy only | `svc-protocol` launch     | Token exists; **no** raise, vesting, or contribution   |
| Escrow      | Shehzad `protocol.escrow` | Potential contribution escrow — human-owned residual   |
| AMM         | `protocol.amm` shehzad002 | Fair launch liquidity later — not this row’s first DoD |

### 2.4 Shehzad board touchpoints

| Board           | Scope                                                         |
| --------------- | ------------------------------------------------------------- |
| S-A7            | Factory honesty (upstream)                                    |
| S-G2            | Presale / fair launch / vesting — stakeOf **read**, no invent |
| Escrow mountain | Non-custodial contribution hold                               |

---

## 3 · Doctrine constraints

| Law           | Implication                                                                   |
| ------------- | ----------------------------------------------------------------------------- |
| §8.4          | `svc-launch` owns launchpad / meme / NFT / RWA product surfaces               |
| §35           | Launch trust layer — vesting proofs, LP locks, honest badges (upgrade path)   |
| §0.6          | Contributions and fees only via ledger recipes on Fiat plane                  |
| §5.2 / stake  | Staked allocation tiers — fail closed on stake service down                   |
| Class M       | Contribution acceptance = money movement                                      |
| Class X       | Jurisdictional offer law for public raises; securities analysis               |
| Cross-service | Stake read via contracts/internal API — not SQL into token tables from launch |

---

## 4 · Architecture sketch (research — not implement)

### Fiat-plane path (custody)

1. Project creates raise config (terms, hard/soft cap, window, tier caps).
2. Contributor commits → ledger recipe locks funds to raise purpose / escrow account.
3. Success → pro-rata or FIFO allocation + vesting schedule entries; failure → refund recipe.
4. Token delivery: either custodial credit or claim against protocol-minted allocation — product law chooses.

### Protocol-plane path (self-custody)

1. Raise/vesting contracts hold assets; platform builds unsigned joins.
2. Stake gate still read from Fiat stakeOf for **allocation eligibility** if product requires IFC stake (S-G2: read only).
3. Platform never holds raise keys.

Hybrid is allowed by doctrine two-plane economy; **mixing without reconciliation** is not.

---

## 5 · DoD sketch (checkable — staged)

### Stage 0 — law

- [ ] Denon/product: presale vs fair-launch defaults, refund rules, dispute, KYC gates.
- [ ] Class X note if public fundraising offer.

### Stage 1 — skeleton (after law)

- [ ] `svc-launch` skeleton + read models for “no active raise” honest empty.
- [ ] Stake tier read integration tests (mock stakeOf).
- [ ] **No** contribution acceptance yet.

### Stage 2 — Fiat contribution (Class M)

- [ ] Ledger recipes: contribute, refund, fee split, settlement.
- [ ] Failure tests: suspended project, stake dropped mid-raise, soft-cap fail, window closed.
- [ ] Allocation respects `launchpadAllocationTier` caps.

### Stage 3 — vesting enforcement

- [ ] Vesting contract (Shehzad) **or** ledger purposed locks with release job — not UI-only.
- [ ] Public vesting proof on token page (§35 direction).

### Stage 4 — protocol raise (optional parallel)

- [ ] Escrow/vesting contracts under Shehzad lane; svc-launch orchestrates unsigned flows.

**Tracker `done`:** Stage 2+3 minimum for title (presale/fair + vesting + tiers). Stage 1 alone is not done.

---

## 6 · Gaps

1. Entire `svc-launch`.
2. No raise schema / state machine.
3. No contribution or fee recipes.
4. No vesting contracts.
5. token-factory not production/audited.
6. Product law for refunds/disputes unset.
7. UI absent.

---

## 7 · Risks

| Risk                         | Notes                                     |
| ---------------------------- | ----------------------------------------- |
| Invent raise economics       | Denon product law required                |
| Accept money without recipes | §0.6 / Class M fail                       |
| UI vesting without locks     | Trust layer lie (§35)                     |
| Ignore stake drop mid-raise  | Must re-check or lock eligibility at join |
| Securities / geo             | Class X — human                           |
| Dual-edit Shehzad escrow     | Babysit                                   |

---

## 8 · Estimated size

| Slice                        | Size            | Notes       |
| ---------------------------- | --------------- | ----------- |
| Law + research accuracy      | **S** Class N   | This pack   |
| svc-launch skeleton          | **S–M**         | After law   |
| Contribution recipes + tests | **M–L** Class M | Second-pass |
| Vesting contracts            | **L**           | Shehzad     |
| Full UI + trust badges       | **L**           | §35 program |

**First implement PR (when free):** scaffold only after law — honest empty raises. **Do not** ship contribution acceptance without ledger recipes + tests. Prefer protocol vesting under Shehzad; Fiat contribution under Class M.

---

## 9 · Related docs / code

- `INTAFACED_DEFINITIVE_BUILD.md` §8.4, §35
- `services/svc-token/src/economics/staking.ts` — `launchpadAllocationTier`
- `services/svc-identity/src/rank/thresholds.ts` — `launchpadTier`
- `services/svc-protocol` launch — deploy only
- `docs/ops/trk/launch.token-factory.md`, `TRK-launch.meme-factory.md`
- Shehzad board S-G2, S-A7
- `packages/config` launch → svc-launch

---

## 10 · Explicit non-goals

- No invent hard-cap numbers, refund %, or dispute SLA.
- No OTC/futures product law under launchpad.
- No R07/R01 stamp content.
- No marking done without vesting enforcement.
- No SQL into token/trade tables from a future launch service.
