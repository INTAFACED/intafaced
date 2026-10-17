# svc-matching — promise audit 2026-08-08

Tip: `c2e98cad` (audit baseline) · landed against `ff6b50c2`

Method: as for svc-p2p — read the service's own written promises and try to falsify each one
against a reachable state. This service has no database, so the "CHECK constraint" half of
the method has no targets here; the analogous boundaries are the idempotency-key contract and
the decimal-string ↔ scaled-bigint conversion, and both were checked instead.

**Provenance tags.** `[me]` = read on tip and confirmed myself. `[reported]` = surfaced by a
read-only harvest agent, not independently re-verified; a lead, not a fact.

The honest summary of this service: price-time priority, self-trade prevention and
determinism are genuinely well built and genuinely well tested. The dangerous items are not
unenforced promises — they are three promises that are enforced _up to a point_ and then
quietly stop, which is exactly what reads as green in review.

---

## Promises checked (78)

| Outcome                                      | Count |
| -------------------------------------------- | ----- |
| VERIFIED                                     | 62    |
| BROKEN — fixed in this wave                  | 1     |
| BROKEN — parked                              | 5     |
| Not applicable (no database in this service) | 7     |

---

## Broken, fixed here

### M1 · The duplicate-order-id guard protects RESTING orders only → #1084 `[me]`

**The finding.** Submit validation rejects a duplicate id only when the id is currently
resting in the book or held by an untriggered stop. `this.index` — the thing it checks — is
populated in exactly one place, inside `rest()`. It is emptied when a maker fully fills, when
self-trade prevention pulls an order, and on cancel.

Two consequences, and the second is the sharper one:

1. An order id becomes reusable the moment its order fully fills, is cancelled, or is pulled.
2. An order that **never rests at all** — a market order, an IOC that fully fills, a FOK, a
   limit that fully crosses — is never in the index at any point in its life, so the guard
   can never fire for it, not even while it is executing.

Against a README that said: _"Duplicate order id · Rejected. Bots retry; a retry that opens a
second order is the worst bug this service could have."_ And a crash-recovery argument resting
on the same sentence: _"a duplicate replay of one input… is idempotent — the order id is
already live, so it comes back `duplicate_order_id`."_ That argument is false for any order
that never rested.

Both existing tests resubmitted an id that was still live, so the suite had never touched the
gap.

**Reachability, checked rather than assumed.** The user-facing path is blocked upstream:
svc-trade looks the order up by id before submitting, with no status filter, so a filled,
cancelled or rejected order short-circuits and the engine is never asked. Orders with no
client id get a fresh UUID per attempt.

The house market-maker seeding path is **not** blocked. It deliberately keeps no order row, so
that lookup does not exist for it, and its ids are deterministic from a run counter that
resets on process restart while the run history persists on disk. After a restart it re-mints
the first run's ids — ids whose orders have long since filled and whose collateral was already
released. `[reported, re-checked by me at the engine end]`

**The fix, and why it is the shape it is.** #1084 does not widen the guard. Rejecting an id the
engine has _ever_ seen means keeping every id forever in a single-process in-memory book, and
any eviction horizon reintroduces the identical bug after it, silently — a guard with an
invisible expiry is the failure mode this audit exists to find, not a fix for it. Order
identity across time belongs to the caller, which has a durable row to check, and svc-trade
already does exactly that.

So the engine now guards what it can see and **says so**: the README states the real scope,
the journal argument is rewritten to rest on replay-once rather than on a guard that cannot
carry it, and two tests pin the real behaviour so it cannot drift back.

**The remaining half is named, not fixed:** svc-trade's seed run-id derivation. One line there,
and svc-trade is human-claimed this wave.

---

## Broken, parked

### M2 · A rejected stop activation consumes sequence numbers `[reported]`

The README says a rejected order "must leave the counter exactly as it found it", and the
normal submit path is careful to check viability before taking a sequence. The stop-activation
path takes a sequence first and checks viability after, so a trigger-rejected stop consumes
two. A test exercises that path and asserts nothing about the counter.

**Why parked:** unverified by me, and the fix is a one-line reordering whose blast radius is
the sequence numbers that fill events are keyed on — I will not reorder that without reading
the replay interaction first, and I ran out of lane.

### M3 · Book mutated before events publish, and recovery emits nothing `[reported]`

Every input is journalled before the book moves — that part is real and tested. But events
publish _after_ the book has moved, with nothing recording that they published, and recovery
deliberately emits nothing. A crash between the two, or a publish that throws partway through
a multi-event submission, loses fills permanently.

This is the same shape as the svc-p2p finding fixed in #1069, one layer out: a commit
followed by a side effect that nothing re-drives.

**Why parked:** same reason as svc-p2p's P1 — the general answer is a transactional outbox
designed once for every service, not improvised per service.

### M4 · `FileJournal` has no tests at all `[reported]`

Everything the README claims about durability — append-only, `fsync` per record, "the fsync
is the whole point and it is not negotiable" — is asserted only against the in-memory journal.
The file implementation is constructed in exactly one place and covered by nothing. The write
call's return value is not checked, and every line is parsed unguarded at boot, so a torn
final line from a crash mid-append produces a journal the engine can never boot from.

**Why parked:** genuinely worth a test and it is the cheapest way to turn a paragraph of prose
into a red bar. Not landed because it is svc-matching's third-priority item behind M1, and the
lane's PR budget went to the two p2p money bugs. Recommended as the second pickup.

### M5 · Snapshots are computed, stored, and never read `[reported]`

The snapshot cadence knob works and is tested. The production sink is in-memory, so snapshots
are written to a field, read by nobody, and lost in exactly the crash they exist for. Recovery
replays the entire journal from record one, so restart cost is O(all history) forever and the
cadence setting has no effect on it.

**Why parked:** this is a missing feature (a durable snapshot sink), not a broken promise.

### M6 · A cancellation's reason never reaches the bus `[reported]`

Cancellations carry a reason internally — self-trade prevention, IOC remainder, market
remainder, trigger rejected — and the published event drops it, because the catalog payload has
no field for it. A consumer cannot tell a self-trade prevention from a user cancel.

**Why parked:** the fix is a catalog change in `packages/events`, another session's lane this
wave.

---

## Could NOT break, having tried

- **Price-time priority.** Sorted level arrays with binary-search insertion, FIFO within a
  level, partial fills mutating in place so a queue position survives, and empty levels removed
  in the same pass so one is never observable as the best price. I looked for an ordering
  violation and found none; the tests are real and non-vacuous. `[me, by reading]`
- **Fill price is always the maker's price.** Holds, and the VWAP test would catch a
  regression. `[reported]`
- **Self-trade prevention in the match path.** No account can be both maker and taker of one
  fill, and the FOK viability check correctly excludes the account's own resting liquidity.
  `[reported]` — with the caveat that the test literally named for this asserts over an empty
  array; the real coverage comes from two other tests.
- **Determinism.** Replaying the journal twice produces byte-identical state, with fixed key
  order and sorted market ids making the comparison meaningful rather than incidental.
  `[reported]`
- **No floating point anywhere in the serialised book.** Amounts are scaled bigint throughout
  and the parser throws rather than truncating past 18 decimal places. `[me]`
- **This service holds no balances and posts no ledger transactions.** The only ledger import
  anywhere is the money-formatting subpath. Verified by import audit. `[reported]`
- **There is no `DATABASE_URL`.** Genuinely enforced by the env schema composition, not by
  convention. `[reported]`
- **Service-only writes.** Submit and cancel require a service credential whose signature
  covers the body, so a captured signature cannot be replayed against a different order.
  Well tested. `[reported]`
