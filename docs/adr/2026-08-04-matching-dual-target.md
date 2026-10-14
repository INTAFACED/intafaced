# ADR: matching dual-target — one spec, two runtimes, and two different words for "final"

**Status:** accepted  
**Status note:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec id:** D-S-06.
**Ground truth:** `svc-matching` exists and runs. **INTACORE does not exist.** P1 implement is **parked** ([`2026-09-03-protocol-rails-until-intachain.md`](2026-09-03-protocol-rails-until-intachain.md)) — Fiat matching stays the house book until Nitro GO. This ADR still binds the second runtime _when_ it is built.

---

## Decision 1 — the matching SPEC is shared. The RUNTIME is forked. The FINALITY is not shared at all.

> **A fill is final when the authority of its own plane has recorded it — and the two planes have different authorities, so "final" means two different things. They must never be presented to a user as the same guarantee.**
>
> - **Fiat Plane:** a fill is final when **the ledger has posted it**. Not when the engine matched it, and not when the journal recorded it.
> - **Protocol Plane:** a fill is final at **chain finality**, on whatever depth that chain's rule defines. Nothing produces this today.

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## Why the engine's own record is not finality

`svc-matching` keeps a journal and can replay it deterministically. That determinism is real and valuable — `matching.determinism` is a tracker row of its own, and replay yielding an identical book is exactly the property an engine should have.

**It is not finality, and the difference has already cost us.** `svc-ws` took its market list from the engine's journal rather than from the registry, and the journal carried ids from a previous database seed. The result was a 0-market intersection and a blocker that survived **26 agent cycles** — sealed in [`2026-08-04-market-id-authority.md`](2026-08-04-market-id-authority.md).

The general lesson: **the engine is an authority on what it matched, never on what is true.** A match is a proposal. It becomes a fact when the book that owns the value records it, and in the Fiat Plane that book is `packages/ledger-client`, by §0.6.

So a fill that the engine has matched but the ledger has not posted is **pending**, and every surface must say pending. Not "filled". Not a number in a balance. This is the same discipline `svc-pay`'s crypto rail already applies to chain transactions — _"Under the threshold the answer is `pending`, because a shallow transaction can still be reorganised away"_ — and it transfers exactly.

---

## Decision 2 — what is shared and what is forked

| Layer                                                                   | Shared or forked                       | Why                                                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Order semantics** — types, TIF, price/size validity, self-trade rules | **Shared, and it is the whole point.** | A user must not learn two different meanings of "limit". This is the spec both runtimes implement.                  |
| **Price-time priority and matching algebra**                            | **Shared.**                            | If the two disagree about who gets filled first, the platform has two markets wearing one name.                     |
| **Determinism requirement**                                             | **Shared.**                            | Both must replay to an identical book. The property, not the implementation.                                        |
| Engine implementation                                                   | **Forked.**                            | One is a service; the other would be a contract on a chain. Nothing is gained by sharing code across that boundary. |
| Journal / storage                                                       | **Forked.**                            | Postgres vs chain state.                                                                                            |
| **Finality**                                                            | **Forked, and load-bearing.**          | Ledger post vs chain finality. See Decision 1.                                                                      |
| **Custody**                                                             | **Forked, and absolute.**              | Fiat is custodial; Protocol is not. §16.10, enforced by `custody-scan`.                                             |
| Market identity                                                         | **Open — see below.**                  | The market-id ADR deferred this here on purpose.                                                                    |

**The rule that keeps the fork honest:** anything in the shared rows must be expressed once, in a place both runtimes read — a spec document plus conformance tests, not two implementations that happen to agree today. The custody-scan lesson applies: _a mirror nobody checks is a mirror that drifts_, and it drifts in the direction that reports clean.

---

## Decision 3 — market identity across planes stays open, and the default is "different"

[`2026-08-04-market-id-authority.md`](2026-08-04-market-id-authority.md) says: _"This says nothing about INTACORE's on-chain market identity… whether its ids are these ids is an open question and belongs to D-S-06."_

> **Until someone decides otherwise, an INTACORE market is a DIFFERENT market from a Fiat market with the same symbol, and its id is a different id.**

The safe default is separation. If the two turn out to be the same market, merging two id spaces later is a migration. If they are different and we assumed they were the same, a user's order goes to the wrong book — and the market-id blocker already showed how long that class of bug survives, because every layer looks locally correct.

**`BTC/USD` on the Fiat Plane and `BTC/USD` on INTACORE are two markets with one display name until an ADR says otherwise.** Any surface showing both says which is which.

---

## Refuse cases

| Situation                                         | Correct answer                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Engine matched, ledger has not posted             | **Pending.** Never "filled", never a balance change.                                     |
| Ledger post fails after a match                   | **The fill did not happen.** The engine's record is corrected, not honoured.             |
| Chain fill below finality depth                   | **Pending.** Same word, different mechanism, and the surface says which.                 |
| A blotter shows fills from both planes            | **Label the plane per fill.** Two finality guarantees may not share a column unlabelled. |
| A market id from one plane used against the other | **Refuse.** Different id spaces until an ADR merges them.                                |
| Engine and ledger disagree about a fill           | **The ledger wins, loudly.** This is a reconciliation event, not a display bug.          |
| Any service answering "does this market exist"    | **Read the registry.** Never the journal. Sealed by the market-id ADR.                   |

---

## Non-goals

- **This does not design INTACORE's engine.** That is Shehzad's chain board. This says what it must conform to if its fills are to appear beside ours.
- **This does not decide whether liquidity is ever shared** between the planes. It is not, today, and unifying two books is a much larger question than unifying two ids.
- **This does not make `svc-matching` wrong.** Its journal is correct for what it is — the market-id ADR already says so. The error is only ever treating it as the answer to a different question.

---

## Done bar

1. No surface reports a fill as final before its plane's authority has recorded it. Tested on the failure path, not just the happy one.
2. Ledger-vs-engine disagreement raises a reconciliation event; it is never resolved in favour of the engine.
3. Order semantics are expressed once, with conformance tests any runtime must pass. Shared rows: [`2026-09-18-matching-shared-conformance.md`](2026-09-18-matching-shared-conformance.md). Fiat pins: `services/svc-matching/src/engine/shared-conformance.pin.test.ts`.
4. Market ids from different planes cannot be interchanged — refused, with a test.
5. Any blotter mixing planes labels each fill's plane.
6. No service determines market existence from a journal.

---

## What agents may implement without asking again

- The pending-until-posted rule on every fill surface, Fiat Plane.
- Conformance tests for the shared order semantics.
- Refusing cross-plane market ids.
- Plane labelling wherever fills are shown.

## What still needs the owner

- **Whether INTACORE market ids are Fiat market ids.** Default until then: they are not.
- Whether the two planes ever share liquidity or a blotter as one market.
- The INTACORE engine itself — Shehzad's board, and this ADR does not reach into it.
