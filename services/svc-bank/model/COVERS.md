# The ReceivedHold model: what it checks and what it covers

`ReceivedHold.tla` is a TLA+ model of one stranger's payment held for its recipient: setting it aside, then releasing or returning it. Two placers work on one `placing` row: the send's own call after it posted (`placeFor`) and the recovery timer (`sweep`). The recipient's balance goes down and up at any time. Each hold post is a request that lands, is refused or never arrives, and lands only within the in-flight bound of when it was sent. The TLC model checker tries every order of those steps against these rules:

- **NeverStranded** (the promise): once a payment's hold lands, its row is never `lapsed`, so the money set aside can always be reached.
- **HoldOnce**: the hold is booked once.
- **OneOutcome**, **OutcomeMatches**: the payment is released or returned, never both, and the row says which.

## Run it

```
services/svc-bank/model/check.sh
```

It needs Java 11 or later (`java` on the PATH, or `JAVA=/path/to/java`). It downloads the TLA+ tools pinned to v1.7.4 by URL and SHA-256 into `~/.cache/intafaced-tla`. It takes about 25 seconds on the Mac. `SHOW_TRACE=1` prints the order of events for each violation.

| Run                        | What                                                  | Expected                                |
| -------------------------- | ----------------------------------------------------- | --------------------------------------- |
| `code-one-placer`          | the code, the timer alone, every rule                 | no error (4,519 distinct states)        |
| `code-two-placers-strand`  | the code, both placers, the promise                   | **NeverStranded violated**: the finding |
| `code-two-placers-kept`    | the code, both placers, every other rule              | no error (526,856 distinct states)      |
| `fixed-two-placers`        | the proposed fix, both placers, every rule            | no error (464,614 distinct states)      |
| `broken-lapse-at-once`     | lapse on the first refusal, without waiting the bound | NeverStranded violated                  |
| `broken-hold-key-repeats`  | the hold key is not idempotent                        | HoldOnce violated                       |
| `broken-claim-without-cas` | a claim that does not check the row is still held     | OutcomeMatches violated                 |

`code-two-placers-strand` passes the script while the code breaks the promise: it records the finding. When the fix lands it changes to `pass`.

## The finding

Two orders of events strand the money (`SHOW_TRACE=1`):

1. A request still on its way: a placer tries again after an earlier refusal, and its request is slow. The other placer is refused for funds, reads a `refused_at` older than the bound and marks the row `lapsed`. The recipient is paid by someone else, then the slow request lands. The money sits in `pay:recv:<transferId>`, and nothing ever picks up a `lapsed` row. The header says the lapse waits for the bound "since its last attempt", but the code checks only `refused_at`; `attempted_at` is written and never read.
2. A stale read: the timer's pass reads the row as `placing`, and the other placer lapses it. The timer then writes `attempted_at ... WHERE state = 'placing'`, which matches nothing, and posts the hold anyway.

The proposed fix (`StrictLapse`): a placer posts only when its `attempted_at` update found the row still `placing`, and the lapse is one conditional update that also requires the stored `attempted_at` to be older than the bound.

The same on the real service with a real Postgres: `src/holds/received-holds.db.test.ts`, the two tests under the `ReceivedHold.tla` comment.

## What it covers

| Model step                           | Code (`services/svc-bank/src/holds/received-holds.ts`)                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `Start`                              | `placeFor` (`find`) and `sweep` (the pass's `SELECT`): the row as the placer read it   |
| `Attempt`, `Timeout`, `Land`, `Lose` | `place`: the `attempted_at` update, `ledger.post(payReceivedHold)`, its answer or none |
| `Decide`                             | `place`: `getTxByKey`, the short-refusal lapse (`markLapsed`), `refused_at`, `held`    |
| `Claim`, `Finish`                    | `decideHold` and the release date in `advance`; `finish`                               |
| `Spend`, `Receive`, `Tick`           | the recipient's other payments, and time against `POST_IN_FLIGHT_BOUND_SECONDS`        |

Not covered: the send itself and the "never arrived" lapse (the model starts with the send posted), the release date's own timing, and the timer's singleton lock (one timer pass at a time is assumed).

## Last confirmed

Against `origin/main` at `76621e07ff`, 16 Nov 2026. Whoever changes a covered function reruns `check.sh` and updates this line.
