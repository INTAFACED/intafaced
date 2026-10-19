# ADR: Launchpad raise economics — named params, sockets, refuse until set (D26-P0-13)

**Status:** **Accepted — 2026-08-15 (law catalog + refuse).** Magnitudes remain **unpublished**. This ADR does **not** invent raise math.
**Decision owner (magnitudes):** Nitro (authority store). **Law catalog owner:** Denon.
**On-chain implement:** Shehzad (`launch.launchpad` · S-G2 / escrow / vesting). Agents babysit only.
**Board:** `DENON-HARD-PARALLEL-BOARD-2026-08-09.md` (removed) **D26-P0-13**.
**Packet:** `OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md` (removed) P0-13.
**Prior seal (still binds):** [`2026-08-14-remaining-p0-money-law.md`](2026-08-14-remaining-p0-money-law.md) § D26-P0-13 — empty store → typed refuse, not a default curve.
**Research pack:** [`docs/ops/trk/launch.launchpad.md`](../ops/trk/launch.launchpad.md) (Stage 0 law). Tracker owner remains `shehzad002` for contracts.
**Law cited:** [`INTAFACED_DEFINITIVE_BUILD.md`](../../INTAFACED_DEFINITIVE_BUILD.md) §0.6 · §8.4 · §35.
**Leverage:** Phase B row `launch.launchpad` is **S** (Shehzad plane). This PR is **LAW only** — no `svc-protocol`, no Solidity, no Vue, no token-factory UI.

---

## The decision

> **Raise economics are refuse-closed until Nitro publishes the named parameters below in an authority store. Agents and Shehzad must not ship invented raise percentages, caps, fees, vest lengths, or allocation shares. Doctrine names the surfaces; it does not fill the numbers. On-chain implement stays Shehzad after the store is set — not before.**

Done bar for **D26-P0-13:** this catalog is on tip; every magnitude is explicit **unset**; socket vs law is named; invented raise % is forbidden on both planes.

---

## Law vs socket (do not collapse)

| Kind                                          | What it is                                                                                                                                                                                                                                                                                                                  | Who fills it                                                                      | Until filled                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Law (magnitudes + money-moving mechanism)** | The named parameters in §1–§2. Publishing them is an owner click into an authority store — not a seed in `economics/*.ts`, not a Solidity constant, not a UI default.                                                                                                                                                       | Nitro (numbers). Denon (this catalog).                                            | Typed refuse. No live contribution, no live raise config that implies a curve.       |
| **Law (already settled, not numeric)**        | Two-plane settlement honesty; vesting must be enforced (contract or ledger lock), never a UI countdown over free balance; house take (if any) is a disclosed ledger recipe (§0.6); stake eligibility reads canonical `launchpadAllocationTier` / `token.stakeOf` and fails closed if stake is down; no second stake ladder. | Doctrine + this ADR.                                                              | Binding now.                                                                         |
| **Socket (implement hole)**                   | Contracts, recipes, factory address, product shell, Class X offer content. Named so nobody “closes” them by inventing law.                                                                                                                                                                                                  | Shehzad (chain). Agents (Fiat recipes **after** magnitudes). Class X (offer/geo). | Stay socket. Scaffold that **refuses** is allowed; scaffold that **accepts** is not. |

`spine-academy-launch` is **prior art to avoid** (`SPINE-BRANCH-DISPOSITION-2026-08-09.md` (removed) §6.1): it invented oversubscription, refund-on-dust, fee-on-fail, house rounding, and a **second** stake-tier system. Do not reuse those numbers or that ladder.

---

## 1 · Named economic parameters (unset — refuse until set)

These names are law. **No values are published here.** An agent or contract that fills any of them has left the sealed zone.

### 1.1 Size and window

| Param id                                                | Meaning                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `launch.raise_soft_cap`                                 | Soft-cap notional (decimal string + asset). Miss → fail/refund path per §2 (also unset). |
| `launch.raise_hard_cap`                                 | Hard-cap notional. Oversubscription rule is §2, not a silent extra %.                    |
| `launch.raise_window_start` / `launch.raise_window_end` | Contribution window. Closed window → refuse, not a hidden extension.                     |
| `launch.min_contribution` / `launch.max_contribution`   | Per-join bounds. Unset → refuse join, not “any size”.                                    |
| `launch.settlement_asset`                               | Accepted contribution asset(s). Unset → refuse. Do not default to a house stable.        |

### 1.2 Allocation and stake

| Param id                        | Meaning                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch.allocation_cap_by_tier` | **Per-tier raise allocation** (how much of a raise each `launchpadAllocationTier` 0…4 may take). **Not** the IFC `minStake` ladder in `svc-token` — that ladder is eligibility identity only. Inferring caps from minStake is invent. |
| `launch.allocation_mode`        | How fills are granted when demand exceeds remaining cap (see §2). Unset → refuse oversubscription rather than pick pro-rata or FIFO.                                                                                                  |

Existing stake **gates** (`token.stakeOf`, `launchpadAllocationTier`) may be read. They do **not** imply a live raise or a published allocation table.

### 1.3 Vesting

| Param id               | Meaning                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `launch.vest_start`    | When vesting clocks start (TGE, raise-success, or named timestamp).                         |
| `launch.vest_cliff`    | Cliff duration.                                                                             |
| `launch.vest_duration` | Full vest duration after cliff (or inclusive — owner must say which).                       |
| `launch.vest_curve`    | Release shape (e.g. linear vs step). Unset → no schedule, not “linear by default”.          |
| `launch.team_vest_set` | Team/insider vest set if distinct from public. Unset → no public “team vested” claim (§35). |

§35 requires **enforced** vest proofs. A countdown over spendable balance is a lie. Enforcement without published params is still refuse — you cannot lock a number you invented.

### 1.4 House take and refunds (money)

| Param id                     | Meaning                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch.house_fee_bps`       | Platform raise fee, if any. `0` is an explicit published zero; **empty is not zero**.                                                                    |
| `launch.fee_on_failed_raise` | Whether a failed raise still takes a fee. Unset → do not take a fee (refuse fee path), and do not invent “no fee” as a marketed default until published. |
| `launch.refund_dust_rule`    | Dust remainder vs partial fill vs full refund. Unset → do not allocate remainder.                                                                        |
| `launch.creator_fee_bps`     | Creator share of trading/raise fee if distinct from house. Unset → refuse that split.                                                                    |

Any fee that moves value is a **named ledger recipe** on the Fiat plane (§0.6). Protocol-plane fees are Shehzad **after** these params exist — not constructor literals.

### 1.5 Product mode (named, not defaulted)

Doctrine §8.4 names **presale** and **fair-launch** as surfaces. Which mode is live, and the fair-launch bonding-curve terms (§35), are owner params:

| Param id                  | Meaning                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `launch.mode`             | `presale` · `fair_launch` · (later modes only by later ruling). Unset → no live raise. |
| `launch.fair_curve_terms` | Bonding-curve / discovery terms if `fair_launch`. Unset → that mode refuses.           |

Do not treat “fair launch” as permission to invent a curve.

---

## 2 · Money-moving mechanism (also law — also unset)

These are not sockets. Picking one in code **is** inventing economics.

| Mechanism                                                      | Unset posture                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Oversubscription (pro-rata vs FIFO vs reject-new)              | Refuse new joins once remaining cap cannot be granted without a rule.                                                                                                                |
| Raise success predicate (soft-cap hit vs owner seal vs always) | No “success” transition that mints or unlocks.                                                                                                                                       |
| Open-raise cancel                                              | Do not invent cancellable vs locked. Refuse cancel **and** refuse “uncancellable” copy until published.                                                                              |
| Mid-raise stake drop                                           | Re-check vs lock-at-join is owner law. Until set: fail closed on stake service down; do not keep a join that no longer meets a published tier cap (caps themselves unset ⇒ no join). |

---

## 3 · Sockets (implement holes — not economics)

Fill these **after** §1–§2 are published. Filling them first with invented % is the failure this ADR exists to stop.

| Socket / hole                                             | Owner                             | Honest residual                                                                                    |
| --------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| Raise / vesting / escrow **contracts**                    | Shehzad                           | No dedicated launchpad contracts on tip. Do not deploy with baked fee/cap/vest constants.          |
| Token factory production address / audit                  | Shehzad + `socket.contract-audit` | Factory is deploy-only today; not a raise engine.                                                  |
| `svc-launch` product shell                                | After law                         | Does not exist. Honest empty / refuse is Stage 1 of the TRK pack — **no contribution acceptance**. |
| Ledger recipes: contribute, refund, house fee, settlement | Agents only **after** params      | None under `packages/ledger-client` for launch. Do not add recipes that encode invented bps.       |
| LP lock / honest-market badges (§35)                      | Shehzad + product                 | Trust layer mountain — not a substitute for raise params.                                          |
| Public fundraising / securities / geo offer law           | Class X (Nitro + counsel)         | Refuse public raise copy and geo-open doors until counsel list/seal. Engineers do not draft it.    |
| Dispute SLA                                               | Owner                             | Unset. No invented hours.                                                                          |

Typed refuse strings (when a door is later wired) should name the residual, e.g. `launch.raise_economics_unset` — **not** a guessed cap. This ADR does not ship that door.

---

## 4 · What Shehzad may and must not do

**May:** unsigned join/claim flows, escrow/vesting **mechanism**, stakeOf **read** (S-G2), fail-closed when factory/chain/params missing.

**Must not:** constructor or init params that invent `house_fee_bps`, allocation %, vest cliff/duration, hard/soft cap, or a second tier table. A contract that _accepts_ owner-supplied params at deploy is fine **only if** the product refuses to build calldata until the authority store is populated. Hard-coded “temporary” 5% / 10% / 30-day vest is a doctrine crime on the chain plane the same as on Fiat.

---

## 5 · What agents may do without asking again

- Point every launchpad contribution/fee/vest surface at this catalog and refuse when the store is empty.
- Keep reading `launchpadAllocationTier` as **eligibility identity**, not as allocation economics.
- Babysit Shehzad PRs for invented constants.
- Stage-1 honest-empty `svc-launch` **after a separate claim** — still no money in.

## 6 · What they must not do

- Invent or copy raise %, caps, cliffs, curves, or fee-on-fail from `spine-academy-launch` or from peer launchpads.
- Ship Vue / token-factory product UI for a live raise (Nitro front-end lane + this refuse).
- Mark `launch.launchpad` done because a UI countdown exists.
- Dual-edit `svc-protocol` under this tracker id.

---

## Authority store (shape, not values)

When Nitro publishes, values live in the same kind of host authority as other DIRECTION §8 numbers (env / `token_params`-class store — **not** a git seed). Empty, whitespace, or partial tables → the **whole raise** refuses. A published `0` is explicit. Partial (e.g. cap set, vest empty) is still refuse: vest without a curve is not §35.
