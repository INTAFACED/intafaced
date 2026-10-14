# ADR: the fill business key stays as it is — detect the loss, do not re-derive the id

**Status:** accepted  
**Status note:** **Accepted — 2026-08-07.** Closes the open question left by [#899](https://github.com/Phantom-X-007/intafaced/pull/899) and [#959](https://github.com/Phantom-X-007/intafaced/pull/959).
**Decision owner:** repo owner. **Class:** M (money key).
**Reason this exists:** two PRs named a follow-up decision and neither took it. An open money-key question with two obvious answers is one somebody eventually picks in a hurry.

---

## The problem, stated once

`fillIdFor(marketId, sequence)` derives the id of a match. That id is also the ledger's idempotency key, `trade.fill:<fillId>`.

`sequence` comes from `OrderBook.sequence` — an **in-memory counter that starts at 0**. It survives a restart only through the journal: `replay()` re-executes the recorded inputs, `fromState()` restores it from a snapshot. In the deployed shape the journal is a named volume (`matchingjournal`), so it normally does survive.

It does not survive **asymmetric data loss** — the engine's volume cleared while Postgres keeps `trade.fills`. A wiped `.data`, a container re-created with an anonymous volume, a restore of one and not the other. The engine then issues sequence 1, 2, 3 for a market whose fills already run to five hundred, and the ledger key starts pointing at trades that settled weeks ago.

## The two answers

### A — put an engine epoch in the key

Add a per-boot epoch so `fillIdFor(market, epoch, sequence)` cannot collide across restarts. This is the one that sounds like the real fix.

**Rejected, and not narrowly.** The derivation is not versioned and cannot be applied to new fills only — the function has no way to know which era a `(market, sequence)` belongs to. So changing it changes the id of **every historical fill**, and therefore every historical ledger key.

The consequence is the opposite of the problem it solves. Today a replayed old fill computes the key that already exists, the ledger returns the original transaction, and nothing moves twice. With the derivation changed, that same replay computes a **new** key the ledger has never seen — and posts a second time. We would trade a loud, caught failure for a silent double-spend, in order to prevent a rarer version of the loud one.

### B — make the loss impossible

Persist the counter so it cannot regress. Also rejected, for a smaller reason: it does not address the failure. The counter is already persisted, twice — journal replay and snapshot restore. The scenario that breaks it is the one where that persistence is _gone_, and a mechanism that lives in the same volume cannot survive that volume being cleared.

A high-water mark held outside the engine would work, but the only component that knows what has settled is `svc-trade`, and having the engine ask the product layer what sequence it may issue inverts §5.1 for a failure mode that has never occurred in production.

## The decision

**Neither. The key stays as it is, and the loss is detected instead.**

Both halves are already in place and this ADR ratifies them as the answer rather than as steps toward one:

| Layer                                                                        | What it does                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insertFillLeg` — [#899](../../services/svc-trade/src/spot/trade-service.ts) | A second claim on `(market, sequence, role)` is read back and compared. Byte-equal is a redelivery and is absorbed; anything else throws `trade.fill_sequence_conflict`, naming both fill ids. Nothing is mis-settled. |
| `/ready` — [#959](../../services/svc-trade/src/spot/sequence-guard.ts)       | `engineSequence >= MAX(trade.fills.sequence)` per market, checked on the probe a load balancer reads. A replica whose engine has forgotten never enters rotation.                                                      |

The invariant is sound in the direction that matters: the engine spends a sequence on every accept and cancel too, not only on fills, so a healthy engine is always _ahead_. Behind is not a race — it means the counter restarted.

## What this costs, honestly

The failure is **contained, not prevented**. If the journal is lost while Postgres is kept, that market stops settling and says so. That is an outage on one market until an operator restores the volume — and it is the correct outcome, because the alternative on offer was a silent double-spend.

## What would reopen this

- A fill id that is versioned at rest, so a new derivation can apply to new fills without touching historical keys. That is a schema change and a migration, not a one-line edit to `ids.ts`.
- Evidence that asymmetric volume loss happens often enough to be worth an outage budget. It has not happened in production; it was found from a CI symptom.

## What must not happen

Adding an epoch to `fillIdFor` because it looks like the tidier design. It is a **silent double-spend**, and the reason is three paragraphs up rather than obvious at the call site. If someone proposes it, this ADR is the reply.
