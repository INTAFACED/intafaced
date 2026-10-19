# ADR: S-D3 — validator security stake is not `token.stakeOf`

**Status:** **Proposed (spec).** Implement of P1 / `svc-chain` stays **parked**.  
**Decision owner:** Nitro. **Written by:** Grok (agents).  
**Spec id:** S-D3 (Shehzad board) · feeds `chain.validators`.  
**Parent:** [`2026-09-18-intacore-module-map.md`](2026-09-18-intacore-module-map.md) (staking module named, not designed) · [`2026-09-03-protocol-rails-until-intachain.md`](2026-09-03-protocol-rails-until-intachain.md).  
**Does not start:** genesis, CometBFT bonding, a validator binary, `chain.mainnet` Done.  
**Does not invent:** min bond, slash %, downtime window, set size, application dates, operator geo.

**Ground truth on tip:** There is no INTACHAIN and no validator set. Product staking **does** exist. It is a different number with a different job.

---

## Decision

> **`token.stakeOf(userId)` is a Fiat product gate. Validator security stake is an INTACORE consensus bond. They are not the same number today. They must not become the same number silently.**
>
> A user who is Architect on the house book does **not** have a validator seat. A validator bonded on INTACHAIN does **not** thereby hold OTC access, launchpad allocation, or a vendor slot.
>
> Careful equivalence, if ever, is a later **owner ADR** that names the mapping, the two ledgers, and the failure if one side moves without the other. This file forbids the silent version.

This is the S-D3 architecture answer `docs/ops/trk/chain.validators.md` (removed) Stage 1 asked for. It is **non-equivalence**. It is not a schedule and not a slash table.

---

## 1 · What `token.stakeOf` is (tip)

| Piece                    | Path                                                                                      | Job                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `TokenService.stakeOf`   | `services/svc-token/src/token-service.ts`                                                 | Sum of **active** rows in `token.stakes` for a user. Custodial IFC. |
| Access ladder            | `services/svc-token/src/economics/staking.ts` `ACCESS_TIERS` / `accessTierFor`            | Gates launchpad tier, OTC, premium lobbies, vendor slots.           |
| Lock tiers               | `STAKE_TIERS` flex / m3 / m12                                                             | Product illiquidity multipliers for yield weight.                   |
| Fee discount             | `feeDiscountBps` keyed on staked amount (known divergence vs §4.3 balance — not this ADR) | Product fee schedule.                                               |
| Governance ballot weight | `token-service.ts` “Weight = stakeOf(userId)”                                             | **Product** ballot in `svc-token`. Not CometBFT voting power.       |

`stakeOf` never reads a chain. It never writes a validator. Unstake is a **ledger** recipe (`token.unstake:${stakeId}`). That is Fiat custody.

The access-ladder **magnitudes already in `ACCESS_TIERS`** (Initiate / Operator / Architect / Sovereign thresholds) are **product gates**. They are not a validator min-bond, and they must not be copied into genesis as if they were.

---

## 2 · What validator security stake is (when P1 exists)

Doctrine §17.3: IFC staking secures validators — a real security budget (bond, downtime, slash), not APY theatre.

| Piece            | Job                                                                      | Home                                                |
| ---------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| Bond             | IFC locked in the INTACORE **staking** module so a validator may produce | Chain state, not `token.stakes`                     |
| Slash / downtime | Punish equivocation / liveness faults                                    | Chain module; magnitudes **owner-only**             |
| Voting power     | Consensus weight                                                         | Consensus, not `accessTierFor`                      |
| Admission        | Who may join the set                                                     | Published schedule + Class X (who may operate, geo) |

Until Nitro GOs P1, none of this code exists. Naming it here does not unpark `svc-chain`.

---

## 3 · Why they must not be equated silently

They fail different questions:

| Question                     | `stakeOf`                                   | Validator bond                       |
| ---------------------------- | ------------------------------------------- | ------------------------------------ |
| Whose money?                 | Platform-custodied ledger IFC               | User’s chain IFC (self-custody)      |
| Who can seize it?            | Platform, via ledger recipes                | Protocol slash rules                 |
| What does it buy?            | Product access                              | The right to produce blocks          |
| What if the number is wrong? | A user sees the wrong lobby                 | The chain’s security budget is a lie |
| Conservation                 | Fiat `totalsByAsset` (cannot see the chain) | Chain supply + bonding module        |

A silent `power = stakeOf(user)` in a future `svc-chain` would:

1. Treat custodial product stake as slashable security — it is not.
2. Let a house-book unstake (ledger) leave a validator bonded, or the reverse.
3. Show “staked IFC” on two surfaces as if it were one bag.

That is the class of bug D-S-06 already paid for with market ids: two authorities wearing one name.

---

## 4 · Careful equivalence (not chosen)

If a later owner ADR wants a mapping, it must say **all** of:

1. Which bag is source of truth for **security** (must be the chain bond).
2. Which bag is source of truth for **product gates** (must remain `stakeOf` unless product law moves).
3. How a move on one side is refused or mirrored on the other — never a cache.
4. That `totalsByAsset` still cannot prove the chain bond (`2026-08-04-cross-plane-bridge-accounting.md`).
5. Magnitudes: still owner-published. **Do not** reuse `ACCESS_TIERS.minStake` as min validator bond because the numbers happen to exist.

Until that ADR merges, implementers treat the two numbers as **unrelated**.

---

## 5 · Progressive opening (schedule is still blank)

`chain.validators` wants a published schedule (T0 permissioned → T+N apply → T+M permissionless). This ADR does **not** fill dates.

| Stage              | Honesty line                                                           | This ADR                                                 |
| ------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| T0 permissioned    | “House (or named) operators. Not permissionless.”                      | Allowed as a label. Operator **identities** are Class X. |
| T+N window         | Dates owner-published. Blank date → do not claim the window is open.   | Named hole.                                              |
| T+M permissionless | Criteria owner-published (min bond, etc.). Blank → not permissionless. | Named hole.                                              |

An empty schedule that never fires is marketing. Do not stamp `chain.validators` done on this file.

---

## Refuse cases

| Situation                                                            | Correct answer                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `svc-chain` reads `token.stakeOf` for voting power                   | **Stop.** Wrong bag.                                         |
| Genesis `min_self_delegation` copied from `ACCESS_TIERS`             | **Stop.** Owner hole, not a product-gate reuse.              |
| UI: “your stake secures the chain” for a flex lock in `token.stakes` | **Mislabel.** Product stake does not secure the chain today. |
| Agent invents 5% slash / 10_000 IFC min bond “so tests look live”    | **Stop.** Unset-refuse.                                      |
| `token.governance` ballot treated as validator admission             | **No.** Product ballot ≠ set membership.                     |
| Claiming permissionless set before owner dates                       | **Refuse the claim.**                                        |
| Adding `services/svc-chain` because this ADR exists                  | **Stop.** Parked.                                            |

---

## Done bar (this ADR)

1. Non-equivalence is the law (this file).
2. A chain engineer opening `docs/ops/trk/chain.validators.md` (removed) Stage 1 finds this path, not a blank.
3. A later `svc-chain` PR that imports `stakeOf` / `ACCESS_TIERS` for bonding **without** a successor ADR is a spec violation. The test that should go red: any module under `services/svc-chain` (when it exists) importing `@intafaced/svc-token` `stakeOf` or `accessTierFor` for admission or voting power.
4. No magnitudes invented. No genesis. No `svc-chain` in this commit.

Fiat-side pin (honesty, not equivalence): `staking.ts` header already says the consumers are launchpad / OTC / lobbies / vendor slots. Do not add “validator” to that list in product code.

---

## What agents may do without asking again

- Keep product staking as product staking.
- After P1 GO: bonding module against **this** non-equivalence, with owner-published numbers or unset-refuse.

## What still needs the owner

- Every bond, slash, downtime, jailed-until, max validators, commission bound (D-S-14 / Class X).
- T0 operator set and geo / sanctions on operators (Class X).
- Schedule dates (T+N, T+M).
- Whether a later ADR carefully maps the two bags (default: never).
- P1 GO.
