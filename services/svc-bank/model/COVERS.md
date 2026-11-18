# The ReceivedHold model: what it checks and what it covers

`ReceivedHold.tla` is a TLA+ model of one stranger's payment held for its recipient: setting it aside, then releasing or returning it. Two placers work on one `placing` row: the send's own call after it posted (`placeFor`) and the recovery timer (`sweep`). The recipient's balance goes down and up at any time. Each hold post is a request that lands, is refused or never arrives, and lands only within the in-flight bound of when it was sent. The TLC model checker tries every order of those steps against these rules:

- **NeverStranded** (the promise): money set aside for a held payment can always be reached. A row lapsed while its hold was still on its way may hold the money for a moment; no row holds it as `lapsed` once the timer's window (twice the in-flight bound) has passed.
- **HeldHasHold**: a row is never `held` or past it without its hold booked.
- **HoldOnce**: the hold is booked once.
- **OneOutcome**, **OutcomeMatches**: the payment is released or returned, never both, and the row says which.

One model minute is one recovery-timer period (60 s by default); the in-flight bound is 2 of them in the model (7 in the code), and the timer's pass looks at lapsed rows at least once a minute.

## Run it

```
services/svc-bank/model/check.sh
```

It needs Java 11 or later (`java` on the PATH, or `JAVA=/path/to/java`). It downloads the TLA+ tools pinned to v1.7.4 by URL and SHA-256 into `~/.cache/intafaced-tla`. It takes about a minute on the Mac. `SHOW_TRACE=1` prints the order of events for each violation. A violated run's state count varies with the number of workers.

| Run                        | What                                                               | Expected                                    |
| -------------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| `code-one-placer`          | the code, the timer alone, every rule                              | no error (32,949 distinct states)           |
| `code-two-placers`         | the code, both placers, every rule                                 | no error (5,447,871 distinct states)        |
| `code-reaches-the-window`  | the code does reach a lapsed row holding the money, which it heals | LapsedNeverHoldsMoney violated (on purpose) |
| `before-fix`               | the code before #8586's fix (the three `fix:` lines taken out)     | **NeverStranded violated**: the finding     |
| `broken-no-claim`          | a placer posts without its claim finding the row still `placing`   | NeverStranded violated                      |
| `broken-window-one-bound`  | the timer looks back only one in-flight bound                      | NeverStranded violated                      |
| `broken-heal-without-hold` | the timer puts a lapsed row back to held without asking the ledger | HeldHasHold violated                        |
| `broken-hold-key-repeats`  | the hold key is not idempotent                                     | HoldOnce violated                           |
| `broken-claim-without-cas` | a claim that does not check the row is still held                  | OutcomeMatches violated                     |

## The finding, and the fix as coded

Before the fix, two orders of events stranded the money (`before-fix`, `SHOW_TRACE=1`):

1. A request still on its way: a placer tries again after an earlier refusal, and its request is slow. The other placer is refused for funds, reads a `refused_at` older than the bound and marks the row `lapsed`. The recipient is paid by someone else, then the slow request lands. The money sat in `pay:recv:<transferId>`, and nothing picked up a `lapsed` row again.
2. A stale read: the timer's pass reads the row as `placing`, and the other placer lapses it. The timer then wrote `attempted_at ... WHERE state = 'placing'`, which matched nothing, and posted the hold anyway.

The fix in `received-holds.ts` (#8586), each line tagged `fix:` in the model:

- **claim**: `place` posts only when its `attempted_at` update returns the row, still `placing`. This closes order 2.
- **un-lapse**: `markHeld` moves a row from `placing` or `lapsed` to `held` when its hold is booked. The placer whose request landed does it.
- **heal**: `sweep` looks again at every row lapsed within twice the in-flight bound; a hold the ledger booked puts it back to `held`. This closes order 1 when the placer that sent the request has timed out.

Lapsing only after the last attempt has aged past the bound, as first proposed, was not taken: the timer tries every minute, so a short row would never lapse.

The same on the real service with a real Postgres: `src/holds/received-holds.db.test.ts`, the two tests under the `ReceivedHold.tla` comment.

## What it covers

| Model step                           | Code (`services/svc-bank/src/holds/received-holds.ts`)                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `Start`                              | `placeFor` (`find`) and `sweep` (the pass's `SELECT`): the row as the placer read it     |
| `Attempt`, `Timeout`, `Land`, `Lose` | `place`: the `attempted_at` update, `ledger.post(payReceivedHold)`, its answer or none   |
| `Attempt` (`fix: claim`)             | `place`: `UPDATE ... attempted_at ... RETURNING`, nothing posted with no row back        |
| `Decide`                             | `place`: `getTxByKey`, the short-refusal lapse (`markLapsed`), `refused_at`, `markHeld`  |
| `Heal`                               | `sweep`'s second step: lapsed rows within `2 * POST_IN_FLIGHT_BOUND_SECONDS`, `markHeld` |
| `Claim`, `Finish`                    | `decideHold` and the release date in `advance`; `finish`                                 |
| `Spend`, `Receive`, `Tick`           | the recipient's other payments, and time against `POST_IN_FLIGHT_BOUND_SECONDS`          |

Not covered: the send itself and the "never arrived" lapse (the model starts with the send posted), the release date's own timing, the timer's singleton lock (one timer pass at a time is assumed), and a placer paused between its claim and its post for longer than the in-flight bound (the model sends the request at the claim, as the code's bound assumes).

TLC's deadlock check is on: every state of this model has a step out (the clock and the in-flight requests run to their bound), so a run that freezes fails.

## Last confirmed

Against `received-holds.ts` with #8586's fix, branch `model/received-hold-strand` off `origin/main` at `76621e07ff`, 16 Nov 2026. Whoever changes a covered function reruns `check.sh` and updates this line.
