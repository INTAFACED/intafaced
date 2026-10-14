# ADR: cross-plane reconciler — first deliverable; no crossing

**Status:** proposed  
**Status note:** **Proposed (spec).** No crossing is enabled. `svc-bridge` is **not** created by this file.  
**Decision owner:** Nitro. **Written by:** Grok (agents).  
**Spec id:** D-S-12 done-bar 1 · S-D7 first slice (ledger half).  
**Parent:** [`2026-08-04-cross-plane-bridge-accounting.md`](2026-08-04-cross-plane-bridge-accounting.md) · handshake [`2026-08-15-cross-plane-bridge-handshake.md`](2026-08-15-cross-plane-bridge-handshake.md).  
**Does not start:** mint-vs-lock, attestation keys, confirmation-depth numbers, `bridge.*` recipes as live crossings, IFC on Base, INTACHAIN implement.

**Ground truth on tip:** `svc-bridge` does not exist. `bridgeBoundary(chain, asset)` exists in `packages/ledger-client/src/accounts.ts` and still has **zero callers**. `totalsByAsset` cannot see a chain. PROTOCOL-P0-MEGA: do **not** deploy a token called IFC this wave; do **not** enable CEX ↔ chain crossing.

D-S-12 already settled the accounting law. This file specifies the **first deliverable** it named: the reconciler. Recooking “the window cannot be one posting” is not this mountain.

---

## Decision

> **The cross-plane reconciler is the first deliverable. No crossing may be enabled before it runs.**
>
> It is the **one** job allowed to read a ledger treasury seam and a chain supply figure **in the same place**. Every other service stays blind to one side (`svc-protocol` / `svc-indexer` must not grow a ledger dependency; `svc-ledger` must not grow a chain client).
>
> A crossing is still two keyed postings with platform (treasury/bridge) exposure, never the user. This file does not enable one.

---

## 1 · What it compares

For each **configured** `(chainId, assetId)` pair:

```
ledger_obligation = -balance(bridgeBoundary(chainId, assetId))
chain_figure      = on-chain locked or minted supply for that asset
                    (Shehzad S-B3 defines which; Q1 still open)
```

**Pass:** both sides readable **and** `ledger_obligation` equals `chain_figure` (exact; no “close enough” bps invented here).

With **zero crossings**, both sides are zero (or the chain figure is “no IFC contract” → **unreadable**, not zero). Unreadable is not balanced.

`totalsByAsset() === 0` is **not** this comparison. Citing it as cross-plane proof is forbidden (D-S-12).

Chain ids are **strings the owner publishes**. `intachain-testnet`, `base-sepolia`, `base` are different seams (`treasury/bridge:intachain-testnet` vs `treasury/bridge:base`). Do not collapse them.

---

## 2 · Readability and halt

| Observation                    | Action                                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both sides readable and equal  | Continue. Crossings remain **disabled** until a later enablement ADR + attestation (Q2) + owner GO.                                                                          |
| Either side unreadable         | **Halt crossings** (already none) **and freeze posture** on that seam. Unreadable ≠ balanced.                                                                                |
| Readable and unequal           | **Halt and freeze**, on the pattern `svc-ledger` already uses for conservation failure. Never continue-and-alert.                                                            |
| Reorg below confirmation depth | Chain figure is **not yet a fact**. Reconciler must not treat a shallow log as `chain_figure`. Under threshold: **pending**, which for the reconciler means **do not pass**. |

Confirmation **depth** is an owner hole. Unset depth → the chain side is unreadable for settle purposes → freeze. Do not git-default `12` or `finalized`.

Attestation (Q2) is still zero keys. Until it lands, D-S-12: **a crossing is operator-gated or it does not run.** The reconciler does not invent a quorum.

---

## 3 · Who may read both (the new law)

Today: nothing may read both. That is why the divergence would be unnoticed.

| Actor                                                                                                                | May                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Reconciler job** (future; name `svc-bridge` reconcilers or a ledger-adjacent worker — implement-time, one service) | Read `bridgeBoundary` via `ledger-client` **and** a **reorg-safe** chain figure (indexer-class source: parent-link, logs by block hash, unwind). |
| `svc-ledger`                                                                                                         | Ledger only.                                                                                                                                     |
| `svc-protocol` / `svc-indexer`                                                                                       | Chain only. Still forbidden a ledger dependency.                                                                                                 |
| `svc-pay` crypto rail                                                                                                | External counterparty rail. **Not** this conservation. `bridge.canonical` forbids the conflation.                                                |

The reconciler consumes `svc-indexer`’s reorg-safe source **or it consumes nothing**. `svc-protocol` first-seen bus events are observation, **forbidden** as a bridge/reconciler input (D-S-12 §5).

---

## 4 · Recipes stay named, not live

D-S-12 keys, still not implemented:

- `bridge.<direction>.hold:<crossingId>`
- `bridge.<direction>.settle:<crossingId>`
- `bridge.<direction>.reverse:<crossingId>`

Precedent: `withdrawHold` / `withdrawSettle` / `withdrawReverse`. Seam: `bridgeBoundary`. Reversal is defined **before** forward.

This ADR does **not** add those recipes. A recipe without a reconciler is how an unnoticed mint becomes permanent. Reconciler first.

Platform exposure: at every instant of a future window, funds are the user’s or the platform’s. Never nobody’s. Never a user spendable that includes value that has left.

---

## 5 · Tests that would go red (when the job exists)

A ledger engineer opens **this file**, then:

1. **Empty-empty:** no chain IFC, no `bridgeBoundary` writes → chain side **unreadable** (no contract) → freeze, not “0=0, all good.”
2. **Honest zeros:** testnet with a published IFC representation whose supply is 0 **and** ledger seam 0 → pass comparison, crossings still **disabled**.
3. **Injected mint:** chain figure +1 with no hold posting → freeze. `totalsByAsset` still 0 — the test **fails** if the job uses that as the check.
4. **Injected hold without chain:** ledger seam negative, chain 0 → freeze.
5. **Shallow block:** chain figure from a log below unset/owner depth → not a pass.
6. **Enablement:** a flag that allows a user crossing while the last reconciler result is freeze/unreadable → refuse.

Until the job exists, the pin is: no `svc-bridge` service, no `bridge.*` recipe used to move user funds, zero callers of `bridgeBoundary` remains honest.

---

## Refuse cases

| Situation                                        | Correct answer                             |
| ------------------------------------------------ | ------------------------------------------ |
| Enable a crossing because this spec exists       | **No.**                                    |
| Deploy a token named IFC on Base this wave       | **No** (PROTOCOL-P0-MEGA).                 |
| Reconciler uses `totalsByAsset`                  | **Wrong check.**                           |
| Reconciler uses `svc-protocol` first-seen events | **Forbidden input.**                       |
| Invent confirmation depth / attestation quorum   | **Owner / Shehzad holes.**                 |
| Platform as guardian on the user’s smart account | **Never** (handshake §3).                  |
| User stranded in the window                      | **Design is wrong.** Exposure is treasury. |
| `svc-bridge` binary in this commit               | **Stop.**                                  |

---

## Done bar (this ADR)

1. First deliverable is named: compare `-balance(bridgeBoundary)` to the chain figure; unreadable or unequal → freeze.
2. Only the reconciler may read both sides.
3. Crossings stay disabled. Depth, attestation, mint-vs-lock stay named holes.
4. A later implementer can fail the tests in §5 against this file.

## What agents may do without asking again

- After owner/Shehzad answers Q1–Q3 **or** with unset-refuse on those params: implement the reconciler job **without** enabling a crossing.
- Keep P0 off IFC-named tokens.

## What still needs the owner / Shehzad

- Q1 mint vs lock (S-B3).
- Q2 attestation set / quorum (S-B5).
- Q3 confirmation depth.
- Q5 KYC tier for a crossing (`jurisdiction.ts` `bridge: OPEN_FULL` still silent).
- Q6 Class X go-live.
- P1 GO (INTACHAIN seam). Base IFC crossing is a **separate** bounded-window program, also blocked on this reconciler.
