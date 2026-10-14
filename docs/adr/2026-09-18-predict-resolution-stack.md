# ADR: Predict resolution stack (spec before the market type)

**Status:** accepted  
**Status note:** **Accepted — 2026-09-18** as **spec**. Predict **code** stays unstarted until INTACORE exists (D-S-18).  
**Decision owner:** Nitro. **Written by:** Grok (agents).  
**Spec id:** Predict-resolution (doctrine §32 · D-S-18 done bar 5).  
**Parent:** [`2026-08-04-predict-quant-connect-law.md`](2026-08-04-predict-quant-connect-law.md) · module map [`2026-09-18-intacore-module-map.md`](2026-09-18-intacore-module-map.md).  
**Does not start:** `services/svc-predict`, INTACORE clob, oracle networks, listing UI.

**Ground truth:** There is no INTACORE, no `svc-predict`, no on-chain Predict market type. Resolution is specified **now** so the first implementer does not invent it.

---

## Decision

> **Resolution is the product.** The book is D-S-06 (outcome shares on INTACORE clob). A prediction market that cannot resolve honestly is a casino with extra steps.
>
> **A market is not listable until its resolution source is named, frozen, and enforceable.** Bond and slash **magnitudes are owner-only** (D-S-14). This file names the mechanism and leaves every number blank.

INTACHAIN P1 implement remains parked. This ADR does not unpark it. It satisfies “resolution stack is specced” so §32 is not blocked on a missing law when P1 GOs.

---

## 1 · What a Predict market is

On INTACORE only (Phase 5P). Not a Fiat ledger book. Not an AMM-only pool sold as our CLOB.

| Kind        | Outcome set                          | Share that wins                                         |
| ----------- | ------------------------------------ | ------------------------------------------------------- |
| Binary      | Yes / No (exactly two)               | The resolved side                                       |
| Categorical | Frozen list, ≥2 named outcomes       | The resolved name                                       |
| Scalar      | Numeric range + unit, frozen at list | Shares redeem per published scalar rule (bound at list) |

Traded as **outcome shares on the INTACORE clob** (price-time, same matching spec). Creation is permissioned at launch (house + verified creators) → governance-opened later (S-D9). Creation/resolution fees, when owner-set, feed the one IFC buyback — **no bps in this file**.

Zero KYC by architecture (Protocol custody). Geo-gate the **hosted front-end** only (`JURISDICTION_MATRIX`). The chain does not invent a jurisdiction list.

---

## 2 · Lifecycle (order is law)

```
propose-create → (resolution source bound) → list
    → trade outcome shares on clob
    → report (designated reporter or oracle adapter)
    → challenge window
    → dispute (optional, IFC-staked)
    → escalate / final
    → settle shares
```

**List is illegal** if any of these is missing: frozen outcome set, frozen scalar bounds if scalar, named resolution source, named designated reporter **or** named oracle adapter, challenge-window parameter **published by owner** (blank → do not list).

Trading **halts** at report; it does not continue “pending resolution” as if the book were still the product.

---

## 3 · Roles

| Role                    | Does                                                | Must not                                                            |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| **Creator**             | Proposes market + binds resolution source at create | Change outcome set after list; resolve                              |
| **Designated reporter** | First report after event                            | Report before the market’s event time; hold user funds              |
| **Oracle adapter**      | Typed feed (one adapter, one job)                   | A score, a default, or a blended “consensus” with no measurement    |
| **Disputer**            | Posts IFC bond to challenge a report                | Invent a rival outcome the market did not list                      |
| **Resolver (final)**    | After window + escalation, writes the outcome       | Touch clob matching rules; post to the Fiat ledger                  |
| **Platform**            | May be creator at launch; never silent reporter     | Be a hidden guardian, upgrade the outcome, or hold Predict balances |

If the designated reporter is absent, the market is **not listed**. An adapter with no live measurements is **no adapter** (D-S-18: no score).

---

## 4 · Resolution source (bound at create)

Exactly one primary, named:

1. **Designated reporter** — identity (smart account / key) frozen at list, or
2. **Oracle adapter** — a concrete adapter id that already has a refuse-closed absent state.

A market may name a **fallback reporter** if the primary misses the window. Fallback is also frozen at list. “We’ll add UMA later” is not a source.

**Allowed adapter classes (when built):** public-data (election/result feed), sports official, weather/numeric for scalar. Each adapter is **absent until connected**. Unscored / unmeasured adapters do not resolve.

Do not list a market whose source is “the house will decide.” If the house is the reporter, say **designated reporter = house key** in the open.

---

## 5 · Dispute escalation (mechanism, no magnitudes)

1. **Report** — reporter/adapter posts an outcome in the frozen set (or a scalar inside frozen bounds).
2. **Challenge window** — owner-published duration. Blank env / unset param → **cannot list**, cannot resolve.
3. **Dispute** — a disputer posts an IFC **bond** (owner-published size). Blank bond → dispute path **refuses**; it does not quietly skip to final.
4. **Escalate** — if disputed, a further round against the same frozen set. Slash the losing bond toward the winner / burn per owner-published split. **No default split in code.**
5. **Final** — one outcome (or one scalar). Clob settles: winning shares redeem; losing shares go to zero. No ledger post. No invented mid.

**Bad report that loses a dispute slashes the reporter’s bond.** Magnitudes stay unset until the owner publishes them. Agents must not seed “reasonable” IFC amounts.

---

## 6 · Honesty / invent ban

| Ban                                           | Why                                                 |
| --------------------------------------------- | --------------------------------------------------- |
| No market listed without a resolution source  | D-S-18 refuse table                                 |
| No outcome added after list                   | Moving the goal is the casino                       |
| No resolution asserted in UI/API before final | Same class as “filled” before ledger/chain finality |
| No returns-ranked Predict leaderboard         | D-S-18 / §8 copy-trading ban                        |
| No blending Fiat books with Predict shares    | Different plane, different ids (S-D2)               |
| No `audited: true` from this spec             | Paid firm, Class X                                  |
| No `svc-predict` until INTACORE clob exists   | D-S-18: not agent work until then                   |

Academy leagues / Scanner / Quant feeds that **display** Predict are readers of resolved/traded state. They do not resolve. House prediction-alpha is a sealed tenant (Throne Law), not the oracle.

---

## 7 · Done bar (spec vs later code)

**This ADR is done when:** the mechanism above is the law (this file). No binary.

**§32 / `predict.markets` code is done only when all of:**

1. INTACORE clob exists (P1 unparked + S-D4 path).
2. Create refuses without bound resolution source + frozen outcome set + owner-published window.
3. List refuses if those are missing.
4. Report → window → dispute → final is implemented with **blank magnitudes refusing**, not invented.
5. Settlement is chain-final on outcome shares; Fiat ledger is untouched.
6. A **resolution-dispute game-theory test suite** exists (doctrine §38) attached to this mechanism — not a vacant DoD row.
7. Hosted FE geo-gate is the only KYC-shaped control; chain stays permissionless to trade.

---

## Refuse cases

| Situation                                              | Correct answer                                 |
| ------------------------------------------------------ | ---------------------------------------------- |
| Asked to list with no reporter and no adapter          | **Do not list**                                |
| Adapter connected but never measured                   | **No adapter**                                 |
| Bond / window / slash unset                            | **Refuse create/list/dispute**, do not default |
| Reporter posts an outcome not in the frozen set        | **Invalid report**                             |
| Scalar outside frozen bounds                           | **Invalid report**                             |
| Agent writes `svc-predict` before INTACORE             | **Stop**                                       |
| Agent fills in 100 IFC bond “for tests that look live” | **Stop** — use unset-refuse tests              |
| Fiat user id used as Predict market id                 | **Refuse** (S-D2 / D-S-06)                     |
| Resolution shown as “likely” from the book             | **Book is not the oracle**                     |

---

## What agents may do without asking again

- Keep this spec. Point §32 / tracker residual at it.
- After INTACORE exists **and** Nitro’s P1 GO: implement create/list refuse paths first, then report/dispute, then settlement. Tests fail-closed on blank owner params.

## What still needs the owner

- Every window length, bond, slash split, creation fee, resolution fee.
- Who may be a verified creator at launch.
- Whether the house is ever designated reporter (if yes, name the key).
- JURISDICTION_MATRIX content for the hosted FE.
- P1 GO (timing of INTACORE itself).
