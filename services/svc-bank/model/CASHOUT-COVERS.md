# The CashOutLock model: what it checks and what it covers

`CashOutLock.tla` is a TLA+ model of one partner-held cash-out request driven by two drivers at once: the customer's call or replay, and the re-drive job or another replica. The request's session advisory lock is held on one reserved connection that sits idle while the body runs on the pool's other connections. If that connection drops, Postgres frees the lock and the body carries on without it. The partner deduplicates moves on their key and keeps nothing under a key it refused, and the customer's money at the partner can arrive at any time. The TLC model checker tries every order of those steps against these rules:

- **RefusedTookNothing** (the promise): once every driver has finished, a refused request took nothing: no move under its key, or the money went back.
- **TakenMeansMoved**, **TakenStays**: a taken request has its move, and stays taken.
- **MovedOnce**: the partner moves the money once.

## Run it

```
services/svc-bank/model/check-cashout.sh
```

It needs Java 11 or later (`java` on the PATH, or `JAVA=/path/to/java`). It downloads the TLA+ tools pinned to v1.7.4 by URL and SHA-256 into `~/.cache/intafaced-tla`. It takes a few seconds. `SHOW_TRACE=1` prints the order of events for each violation.

| Run                           | What                                                          | Expected                                     |
| ----------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| `code-lock-held`              | the code, the lock never lost, every rule                     | no error (55 distinct states)                |
| `code-lock-lost`              | the code, the lock's connection may drop, every rule          | no error (295 distinct states)               |
| `unfixed-lock-lost`           | the code before the fix, the lock may drop, the promise       | **RefusedTookNothing violated**: the finding |
| `unfixed-lock-lost-kept`      | the code before the fix, the lock may drop, every other rule  | no error (279 distinct states)               |
| `broken-no-reread`            | the row is not read again under the lock                      | RefusedTookNothing violated                  |
| `broken-key-repeats`          | the partner does not deduplicate on the key                   | MovedOnce violated                           |
| `broken-refuse-without-check` | the refusal is recorded without `WHERE status = 'processing'` | TakenStays violated                          |

## The finding

The shortest order of events (`SHOW_TRACE=1`): driver A takes the lock, and its connection drops. A reads the row (`processing`) and the partner refuses its move for funds. The money arrives. Driver B takes the free lock and reads the row (`processing`). A records `refused`. B's move under the same key is made, and B's stamp (`WHERE status = 'processing'`) matches nothing and throws. The row says refused and the money sits in the partner's payouts account; `redrive` reads only `processing` rows, so nothing pays it out or gives it back.

The fix (`Fixed`, `giveBackRefused` in the code, #8597): a driver whose move was made but whose stamp found the row no longer `processing` reads the row, and a `refused` one gets its money back under the request's back key (`bank.cash-out-back:<id>`), once, stamped as `partner_back_move_id`. A crash between the move and the give-back is not modelled; for it the re-drive job also looks at partner-held rows refused in the last day whose key has a move and nothing given back (`payouts.db.test.ts`, "a refused request whose move a crashed driver made anyway").

The same on the real service with a real Postgres: `src/cash-out/payouts.db.test.ts`, "a request refused while its lock was lost never leaves the money taken".

## What it covers

| Model step | Code (`services/svc-bank/src/cash-out/cash-out.ts`, `drive`, partner-held branch)                         |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `Lock`     | `withSessionAdvisoryLock(this.sql, LOCK, row.id, ...)`: `pg_advisory_lock` on a reserved connection       |
| `LoseLock` | that connection dropping: Postgres frees the lock; the body runs on other connections and does not notice |
| `Read`     | `this.row(row.id)`; not `processing`, it returns                                                          |
| `Move`     | `heldBank(now).move` under `cashOutMoveKey(now.id)`; the partner's key deduplication and funds check      |
| `Record`   | `moved(id, 'processing', ...)`: `refused` on `bank.partner_insufficient_funds`, else `partner_move_id`    |
| `GiveBack` | `giveBackRefused`                                                                                         |
| `Arrive`   | money reaching the customer's account at the partner                                                      |

Not covered: the ledger (custodial) branch of `drive` and `partner.pay`, which follow the same pattern and are switched off at launch; the self-freeze check; a crash at any step.

## Last confirmed

Against this branch with the fix for #8597 (based on `origin/main` `83b6b0ff54`), 16 Nov 2026 UTC. Whoever changes a covered function reruns `check-cashout.sh` and updates this line.
