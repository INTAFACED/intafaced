# packages/ledger-client — promise audit 2026-08-08

**Tip at writing:** `7a545da7` — `docs(ops): Claude session stop note (#1061)`
**Method:** read what the package promises in writing — the invariant headers in
`client.ts`, the conformance suite's stated job, `accounts.ts`'s explanations, error
class doc comments — and try to falsify each against a reachable state.
**Continues** `AFK-RESIDUAL-STOP-2026-08-08.md` §4.2b, which covered this package
alongside `svc-ledger` and left five of its findings open.

**Verification honesty, once, applying to everything below.** No Docker and no local
Postgres on this machine, so `pnpm verify` reported INCOMPLETE on every run. The
memory engine's half of the conformance suite ran locally; **the Postgres engine's
half is CI-verified only**, and for the conformance findings that is the half that
matters — the whole premise is that a case both engines must satisfy is worth more
than one engine's test.

---

## Promises checked (14)

| #   | The promise, and where it is written                                                                              | Verdict                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `conformance.ts`: "If the two disagree about anything in here, one of them is wrong"                              | **BROKEN** → #1060                                         |
| 2   | `memory-ledger.ts`: it is "the executable specification … the Postgres implementation must match entry for entry" | **BROKEN** → #1060                                         |
| 3   | `client.ts` P0-3: one claim cannot spend another claim's reservation                                              | **BROKEN** (untested) → #1070                              |
| 4   | `assertPairedLocks`: release is safe because sum-to-zero governs where value lands                                | **BROKEN** (untested) → #1070                              |
| 5   | `post()` is atomic — "nothing half-applied"                                                                       | **BROKEN** (untested) → #1070                              |
| 6   | `http-errors.ts`: typed ledger errors survive the HTTP boundary (P2P-01)                                          | **BROKEN** → #1065                                         |
| 7   | `accounts.ts`: `subAccountHold` is a usable account constructor                                                   | **BROKEN** → #1054 (peer session)                          |
| 8   | `escrowRelease` bounds its fee like the four recipes around it                                                    | **BROKEN** → #1051 (prior session)                         |
| 9   | `assertBalanced`: every transaction sums to zero per asset                                                        | VERIFIED                                                   |
| 10  | `assertOwnerIdentifierSpace`: every `ownerId` is from the space its type declares                                 | VERIFIED (22 cases, plus a live-Postgres equivalence test) |
| 11  | `mulBps` / `proRata`: conservation, including a negative total                                                    | VERIFIED (property tests)                                  |
| 12  | `MemoryLedger.balance` creates nothing — a read does not mint an account                                          | VERIFIED                                                   |
| 13  | Money is never a `number`: decimal strings on the wire, scaled bigint in memory                                   | VERIFIED (repo-wide gate)                                  |
| 14  | Every declared error code has a call site                                                                         | VERIFIED — see "could not break" #3                        |

---

## Broken, fixed here

**#1060 · The two engines gave opposite answers about money that had moved.**
`MemoryLedger` checked idempotency before validating; `PostgresLedger` validated
first. One input separates them: replay a committed key with a body validation now
refuses. Memory returns the transaction (the value moved — that is the truth);
Postgres threw, telling a caller its completed money movement was invalid. Downstream,
that caller either retries forever or compensates for a loss that never happened.

Nothing produces that input _today_. What produces it is tightening any validation
rule, and this repo tightened four in one week (#1044, #1050/#1058, #1051, #1054) —
each turned some previously-legal body illegal, and the first retry of an older body
after deploy is the case.

Postgres was wrong, and it was already inconsistent with itself: inside the chain-tip
lock it deliberately checks idempotency _before_ the freeze check, with the reasoning
written out at the line. Validation is the same argument, and the freeze is the
stronger reason to refuse. `assertIdempotencyKey` is now split out so both engines
state one order — key, then idempotency, then body — and the suite replays an invalid
body after commit, which is the case it never sent.

**#1065 · A frozen ledger reached five services as "unknown failure".**
`s2s-http.httpError` puts `code` on the wire for five cases and gives four their own
status; `rehydrateLedgerHttpError` rebuilt **one**. Everything else arrived as a bare
`Error`. Five services call through it, and three write the code into a database
column:

```ts
rejection_code = ${err instanceof LedgerError ? err.code : 'bank.post_failed'}
```

So a card cashback or loan disbursement refused **because the ledger was frozen** — a
deliberate halt with a reason and an actor in `posting_freeze` — was recorded
permanently as `bank.post_failed`. An operator could not tell a halt they ordered from
an unknown failure. Same class of loss as #1055: the reason a money movement was
refused, written down wrong.

Fixed by rehydrating any structured `code` as a `LedgerError`. **Base class, not the
subclass**, deliberately: `UnbalancedTransactionError` carries `perAsset` and
`OwnerIdentitySpaceError` carries the owner type and id, and neither is on the wire —
constructing them with guessed fields hands a caller a typed error whose data is
fabricated, which is worse than an honest base class because it reads as trustworthy.
The test file had blessed the defect: a case literally named _"leaves other failures
as plain Error"_, asserting only `not.toBeInstanceOf(InsufficientFundsError)`, which
passed either way and pinned nothing.

**#1070 · The suite proved two holds read apart, never that one can't spend the
other.** Three gaps in the guard whose whole job is stopping engine divergence:

- **Cross-purpose spend.** `two purposes in one asset are two distinct accounts`
  proves the pots _read_ separately. Nothing proved you cannot draw one down past its
  own balance — the half where the money goes. An implementation storing `purpose` as
  a label beside one shared row (the exact pre-P0-3 shape) passes every existing case,
  because the label round-trips, and fails on the first over-release.
- **A lock released twice.** `assertPairedLocks` constrains locks on the way in and
  leaves release to sum-to-zero. True, and not sufficient alone: a second release
  balances perfectly. What stops it is the non-negative rule on the lock pot, one
  layer down — so the invariant holds **by composition across two guards in different
  functions**, which is the kind of property that survives a refactor by luck.
- **Partial failure mid-transaction.** The existing case rejects a two-entry recipe
  whose only debit is the failing one — which an implementation applying entries one
  at a time also passes, because there is nothing to have applied first. The new case
  fails on the third of four, after two legal ones. Memory stages into a map; Postgres
  uses the transaction. Two mechanisms, one contract.

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

**1 · Strict body-match on an idempotency replay.** Neither engine has ever compared a
replayed body to the stored transaction — both key on `idempotencyKey` alone. So a
caller reusing a key for a genuinely _different_ movement gets the original back and
believes its own post succeeded. #1060 did not widen this and does not narrow it; it
made both engines agree.

Whether to narrow it is a change to a public contract with real arguments on both
sides: strict matching turns some working retries into errors (any caller whose body
is not byte-stable — a timestamp in `meta`, a re-serialised amount — starts failing),
and it needs a decision about what to compare (entries only? `meta`? `reason`?).
**Nitro or the doctrine decides.** The mitigation that _is_ now in place is #1067's
8-character database floor, which removes the placeholder-key version of the problem.

**2 · Conformance gaps that cannot live in a harness-agnostic file.** Recorded so the
next person asking "what does the suite not cover" does not re-derive it:

- **A freeze arriving between validate and commit.** `MemoryLedger` has no freeze
  concept, so the case cannot be stated here. It belongs in `service.freeze.test.ts`,
  which already covers freeze-versus-post across two connections.
- **A chain-tip re-check racing itself.** Postgres-specific — there is no chain-tip
  lock to race in memory.
- **`proRata` at the negative-total boundary.** Already covered and correctly placed:
  it is a pure function, tested in `money.property.test.ts` rather than through a
  `LedgerClient`.

**3 · `assets.decimals` and `mulBps` rounding.** The `mulBps`-side half of the
`decimals` finding. Same reason as the svc-ledger audit's parked #1: choosing what
happens to the sub-unit remainder is a fee policy, DIRECTION §8 is blank, and an agent
picking one would be inventing it. #1064 made the claim honest and left a tripwire.

---

## Could NOT break, having tried

**1 · `assertOwnerIdentifierSpace`.** The strongest guard in the package. 22 cases
here plus `owner-identity.test.ts` asserting the TypeScript regex and the Postgres
CHECK are character-for-character equivalent against a live database — one of the few
places in the repo where a TS/SQL pair is proven equal rather than assumed. Tried the
adapter case it was written for (`String(member.id)` into `userAvailable`) and it is
refused at `post()`, which is also the only path that opens an account.

**2 · `proRata` and `mulBps` conservation.** Property tests over random inputs,
including negative totals and the rounding floor. Shares always sum back to exactly
the total. No counterexample found.

**3 · Declared and never emitted.** Swept all ten `ledger.*` codes for a call site.
Every one is emitted from production code — the class #1035 and #1054 came from is
clean in this package now. Four had no test asserting the code _string_
(`ledger.uninitialised`, `ledger.unbalanced`, `ledger.invalid_entry`,
`ledger.operator_request_failed`), which matters because the string is the wire
contract; #1065 pins five of them, including all four.

**4 · `MemoryLedger.balance` not minting accounts.** A read used to call
`ensureAccount`, which mattered once "does this owner have an account?" became the
question deciding whether an adapter opens a second book for one human. Fixed before
this audit; re-checked and it holds, and the conformance suite asserts it.

**5 · Money never in a `number`.** Repo-wide doctrine gate, and it passes. Checked the
new code in every PR above against it — decimal strings on the wire, scaled bigint in
memory, `formatAmount`/`parseAmount` at every boundary.
