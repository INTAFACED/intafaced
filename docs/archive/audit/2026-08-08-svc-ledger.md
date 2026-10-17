# services/svc-ledger — promise audit 2026-08-08

**Tip at writing:** `7a545da7` — `docs(ops): Claude session stop note (#1061)`
**Method:** read what the service promises in writing — README lines, load-bearing
comments, migration prose, `CHECK` names — and try to falsify each one against a
state the code can actually reach. Fix what breaks, with a test that would have
caught it.
**Continues** the `svc-ledger` audit recorded in `AFK-RESIDUAL-STOP-2026-08-08.md`
§4.2b. That audit produced nine findings and fixed two; this one closes the rest and
adds five of its own.

**Verification honesty, stated once and applying to everything below.** This machine
has neither Docker nor a local Postgres, so `pnpm verify` reported itself INCOMPLETE
on every run and no DB-backed suite executed locally. Every Postgres-level claim here
is **CI-verified** — the Tests job on the named PR — and never verified on my
machine. Where a claim is neither, it says so.

---

## Promises checked (17)

| #   | The promise, and where it is written                                                                                | Verdict                             |
| --- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | `posting_freeze_attributed_ck` (0002): "whoever finds the platform halted must be able to find out why and by whom" | **BROKEN** → #1055                  |
| 2   | `freeze.ts`: "A freeze always carries a reason and an actor" — for _every_ freeze, not just the first               | **BROKEN** → #1055                  |
| 3   | `service.ts`: `ledgerFreezeUpdated` "emits in both directions"                                                      | **BROKEN** → #1055                  |
| 4   | 0007: purposed locks have a database backstop "fail-closed"                                                         | **BROKEN** → #1058                  |
| 5   | `accounts.ts`: an unpurposed collateral pot is distinguishable from a purposed one                                  | **BROKEN** → #1058                  |
| 6   | 0004: `decimals` is "the scale the ledger reconciles the asset at, and it is not cosmetic"                          | **BROKEN** → #1064                  |
| 7   | `assertValidPost`: an idempotency key is at least 8 characters                                                      | **BROKEN** → #1067                  |
| 8   | #1044: "value cannot exist in an asset the ledger has never heard of" — the `ledger_entries` half                   | **BROKEN** (untested) → #1068       |
| 9   | 0000: `chain_tip` is a singleton, because "two rows would raise which one is true"                                  | **BROKEN** (untested) → #1068       |
| 10  | 0002: `posting_freeze` is a singleton, same argument                                                                | **BROKEN** (untested) → #1068       |
| 11  | `accounts_purpose_len_ck`: purpose is capped at 128, and it is part of the identity index                           | **BROKEN** (untested) → #1068       |
| 12  | `postgres-ledger.ts`: the freeze is read inside the chain-tip lock, so no post can outrun it                        | VERIFIED                            |
| 13  | `postgres-ledger.ts`: idempotency is re-checked inside the lock, ahead of the freeze check                          | VERIFIED                            |
| 14  | `service.ts`: `reconcile()` freezes before it publishes, and publishes even if the freeze was a no-op               | VERIFIED (asserted in #1055)        |
| 15  | `applyStartupPolicy`: `LEDGER_POSTING_ENABLED=true` can never thaw                                                  | VERIFIED                            |
| 16  | `schema-drift.test.ts`: `drizzle/*.sql` and `schema.ts` describe one database                                       | VERIFIED                            |
| 17  | `journal()` pages on `seq`, so no page can be skipped                                                               | VERIFIED — see "could not break" #3 |

---

## Broken, fixed here

**#1055 · A second freeze erased the first one's reason, and a fast thaw vanished.**
`writeFreeze` was a bare `UPDATE` with no `WHERE frozen = false`, and `reconcile()`
calls it hourly — so a reconciliation freeze silently overwrote an operator's reason,
and vice versa. `posting_freeze_attributed_ck` still passed: the row was attributed,
just not to whoever halted the platform. Now first-writer-wins, with an identical
re-freeze staying a no-op and a different attribution refused
(`ledger.freeze_attributed`). `reconcile()` swallows exactly that code and still
publishes `ledgerReconciliationFailed`, so a mismatch is never silent because the
freeze was a no-op — and that is now asserted, since it is the reason the refusal is
safe.
Same PR: the freeze event keyed its idempotency id off `changedAt.toISOString()` —
milliseconds — against a `timestamptz` column holding microseconds. A freeze and the
thaw right after it inside one millisecond shared a `msgID`, and JetStream drops the
duplicate: **the thaw.** Every consumer then held "frozen" while the database said
open, with no error anywhere. The key now carries `changed_at::text`, the database's
own rendering.

**#1058 · 0007 invented a purpose for the pots it could not attribute.** Two halves.
The backfill wrote `purpose = 'legacy:' || id::text` on any unpurposed lock pot — a
purpose that names its own row, so the new CHECK began _certifying_ exactly the
unattributable collateral it was added to catch, and no query could separate those
rows from properly-claimed ones afterwards. And the CHECK enumerated the four locked
kinds, so a fifth would have been unconstrained silently. Now: refuse and name (0005
STEP 3 / 0006 STEP 1 precedent), and `kind = 'available' OR (length(purpose) > 0 AND
purpose NOT LIKE 'legacy:%')`, so a new kind is covered from the moment the enum
grows. The test that guarded the constraint was repeating the constraint's mistake —
its own hardcoded four-kind list — and now derives from `ACCOUNT_KINDS`.
**Credit:** both halves were raised by the peer Claude session on #1052; I verified
them against the merged migration and took the fix.

**#1064 · The column that said it controlled decimal places controls nothing.**
`assets.decimals` is seeded per asset and read by no production code — verified
empirically by a test that enumerates every non-test source file in `svc-ledger` and
`ledger-client` and would name any reader. 0004 claimed it was "the scale the ledger
reconciles the asset at"; balances are `numeric(38,18)`, reconciliation compares at 18
dp for every asset, and `mulBps` rounds `ceil`, so fees on a 2 dp fiat leave a
remainder below that asset's smallest unit. Claim corrected at both sites, correction
_recorded_ rather than the sentence deleted, and a tripwire test fails the moment any
code starts reading the column. **Not wired** — see "parked" #1.

**#1067 · Raw SQL could claim the empty idempotency key.** `assertValidPost` has
required 8 characters since 0000; the column had a UNIQUE index and no length CHECK.
The key is the _identity_ of a movement, and since #1060 `post()` returns the existing
transaction for a known key before validating the body — so a row holding `''` means
the next caller whose key normalises to empty is handed that transaction and told its
own movement succeeded. Nothing moves, nothing errors. 0009 adds the CHECK, refuses
rather than repairs (a posted transaction cannot be re-keyed or deleted), and a
raw-SQL test proves the refusal.

**#1068 · Four money guards were executed by no test.** All four are mentioned by
`schema-drift.test.ts`, which proves they _exist_ and are described identically in
both descriptions of the database. That is a different claim: `CHECK (true)` is a
valid CHECK. **Existence is not enforcement** — the distinction that produced #1039
and #1040. Covered now: `ledger_entries_asset_id_fk` (the entries half of #1044,
which had no coverage of any kind — the account half was proven, the _money_ half was
not), both singletons, and the 128-character purpose cap at its exact boundary.
CI found two real faults in this test on its first run, both recorded in the PR.

---

## Broken, parked — now DECIDED

> **UPDATED same day.** Every item in this section was parked as "Nitro must decide".
> He returned it: _"i cannot make decisions myself. you need to make these decisions."_
> All of them are now decided, with the research and a flip condition each, in
> [`2026-08-08-spine-decisions.md`](2026-08-08-spine-decisions.md).
> Short version: the `assets.decimals` question dissolved (doctrine §4.2 invariant 5
> already fixes the ledger at 18 decimals for every asset, so the column cannot be a
> ledger scale); strict idempotency body-matching is **NO**; a trigger backstop for
> sum-to-zero is **NO**, because reconciliation already detects it and freezes; the
> `svc-trade` gate was never violated, only unrecorded; and the cross-asset entry gap
> is **shipped** in #1082 rather than deferred.
> The original reasoning is kept below — it is what the decisions were made from.

### Original findings (now decided, see above)

**1 · What enforcing `assets.decimals` does with the sub-unit remainder.**
Three options, and every one is a fee/rounding policy: refuse the post (a legal 18 dp
fill on a 2 dp currency becomes an error), round to the asset's scale and send the
dust to a named house account (a fee, with an owner and a user-visible consequence),
or keep 18 dp internally and round only on display (the book and the screen then
disagree, and which one settles a dispute is policy). DIRECTION §8 is blank, so
choosing one is inventing a fee policy on the money spine. **Nitro decides which, and
where the dust goes if it is the second.** #1064 makes the state honest and leaves a
test that fails the moment someone wires it inside a three-line diff.

**2 · A database backstop for `assertBalanced` and `assertPairedLocks`.**
Both are statements about a SET of rows inserted together, and a `CHECK` cannot see
other rows — so backstopping either means a trigger on `ledger_entries`, the hottest
table on the money spine. That is a performance and design decision, not a
correctness patch, and not something to land unattended.
Materially different from the unpurposed-collateral case in one way that matters:
`runReconciliation` already re-derives both invariants from the journal, so an
unbalanced raw insert **is** detected — after the fact, by the process whose stated
response is to freeze the platform and page an operator. Nothing detected unpurposed
collateral at all. **Recommendation if it is ever taken: a `CONSTRAINT TRIGGER
... DEFERRABLE INITIALLY DEFERRED` on `ledger_entries`, which fires at COMMIT and can
therefore see the whole transaction.** Not attempted here.

**3 · `ledger_entries.asset_id` is not tied to its account's asset.**
Found while isolating #1068's RESTRICT case, which needs the mismatch to work. Raw
SQL can record an entry in `USDT` against a `BTC` account: the entry lands in one
book and `balance_after` describes another. `postgres-ledger.ts` always uses
`entry.account.assetId` for both, so the TypeScript path cannot produce it. Same
family as #1044 and #1050 and probably a real migration —
`CHECK` cannot reference another table, so it needs either a composite FK
`(account_id, asset_id) REFERENCES accounts (id, asset_id)` with a supporting UNIQUE
index, or a trigger. **Not attempted:** it is a second money-spine migration on top
of 0008 and 0009 in one unattended session, and the documented limit is two. Next
session's first unit.

**4 · The `svc-trade` claim gate contradicts itself.** Not this service, recorded here
because it blocks work adjacent to it. `claim-check` reports `services/svc-trade`
human-claimed by three owners with "an agent must NOT implement here", and #1031,
#1034, #1047 and #1062 all landed in it. Either the gate does not bind agents, or
`features.mjs` and the ownership docs disagree with reality. **Nitro's ruling**, and
deliberately not resolved by an agent editing `features.mjs`.

---

## Could NOT break, having tried

Extends the list in `AFK-RESIDUAL-STOP-2026-08-08.md` §4.2b rather than restarting it.
Previously recorded and still holding: double-entry balancing, idempotency as a
genuine no-op across three layers, lock pairing and double-release, freeze ordering
against posts, `proRata` conservation including the negative-total case, and the
memory/Postgres conformance equivalence.

**1 · Freeze-versus-post ordering.** The freeze is read in the same query that takes
the chain-tip lock, so a post either sees the freeze or committed strictly before it.
Tried to find a window in the service layer; there is none, and the comment explaining
why the read cannot move earlier is correct.

**2 · The in-lock idempotency re-check, ahead of the freeze check.** A committed retry
returns its transaction even while frozen. That looks wrong at first read and is
right: the value moved, and the freeze stops new writes rather than the truth about
old ones. It is also the precedent that decided #1060.

**3 · Journal paging.** The peer session found a live defect in `svc-notify` where a
keyset cursor round-tripped `created_at` through a JS `Date`, losing microseconds and
skipping every row inside that millisecond. **Checked the same class here and it is
clean:** `journal()` and `runReconciliation` both page on `seq`, a bigint, which
round-trips exactly. An honest negative result, and worth recording because the same
question will be asked again.

**4 · The hash chain's timestamp.** `hashTx` hashes `postedAt.toISOString()` and the
row stores the JS value it hashed, so write-then-read is lossless and
`verifyChain` cannot fail on a rounding difference. Specifically checked because
finding #7 above was the same class one function away — and unlike the freeze event,
this one is safe, for a reason worth naming: the value is _written_ from JS rather
than generated by `now()`.

**5 · `ledger.frozen` at every surface.** 11 references, and the code is emitted, HTTP
mapped (412) and asserted in four test files. The only place it was lost was across
the wire into other services — a `ledger-client` defect, fixed in #1065, recorded in
the ledger-client audit.
