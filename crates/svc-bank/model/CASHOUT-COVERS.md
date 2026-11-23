# The CashOutLock model: what it checks and what it covers

`CashOutLock.tla` is a TLA+ model of one partner-held cash-out request driven by two drivers at once: the customer's call or replay, and the re-drive job or another replica. The request's session advisory lock is held on one reserved connection that sits idle while the body runs on the pool's other connections. If that connection drops, Postgres frees the lock and the body carries on without it. The partner deduplicates moves on their key and keeps nothing under a key it refused, and the customer's money at the partner can arrive at any time. The TLC model checker tries every order of those steps against these rules:

- **RefusedTookNothing** (the promise): once every driver has finished, a refused request took nothing: no move under its key, or the money went back.
- **TakenMeansMoved**, **TakenStays**: a taken request has its move, and stays taken.
- **MovedOnce**: the partner moves the money once.
- **No dead end** (TLC's deadlock check): the only state with no step out is `Done`, every driver finished. A driver stuck halfway, with the request's money undecided, fails the check.

## Run it

```
crates/svc-bank/model/check-cashout.sh
```

The folder's `check.sh`, which CI's model check runs, runs it after the ReceivedHold model. It needs Java 11 or later (`java` on the PATH, or `JAVA=/path/to/java`). It downloads the TLA+ tools pinned to v1.7.4 by URL and SHA-256 into `~/.cache/intafaced-tla`. It takes a few seconds. `SHOW_TRACE=1` prints the order of events for each violation.

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

The fix (`Fixed`, `giveBackRefused` in the TypeScript, `give_back_refused` in `crates/svc-bank/src/partner_account/cash_out.rs`, #8597): a driver whose move was made but whose stamp found the row no longer `processing` reads the row, and a `refused` one gets its money back under the request's back key (`bank.cash-out-back:<id>`), once, stamped as `partner_back_move_id`. A crash between the move and the give-back is not modelled; for it the re-drive job also looks at partner-held rows refused in the last day whose key has a move and nothing given back (`payouts.db.test.ts`, "a refused request whose move a crashed driver made anyway").

The same on the real service with a real Postgres is "a request refused while its lock was lost never leaves the money taken" in `crates/svc-bank/tests/partner_account_payouts.rs` (ported from the TypeScript's `cash-out/payouts.db.test.ts`): it holds each driver just before its partner move, ends driver A's lock connection (`pg_terminate_backend`), lets a replay B take the freed lock, then lets A be refused for funds and B's move be made, and checks the request never ends refused with the money taken. It also holds the crash path ("a driver that lost its lock makes the order move anyway, then crashes before giving it back").

## What it covers

| Model step | Code (`crates/svc-bank/src/partner_account/cash_out.rs`, `drive`, partner-held branch)                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Lock`     | `with_lock(d.store, &w.gate, LOCK, &row.id, ...)` (`cash_out/session_lock.rs`): `pg_advisory_lock` on a reserved connection |
| `LoseLock` | that connection dropping: Postgres frees the lock; the body runs on other connections and does not notice                   |
| `Read`     | the row read again under the lock; not `processing`, it returns                                                             |
| `Move`     | `held_bank(...).move_` under `move_key(&now.id)`; the partner's key deduplication and funds check                           |
| `Record`   | `moved(...)` `WHERE status = 'processing'`: `refused` on `bank.partner_insufficient_funds`, else `partner_move_id`          |
| `GiveBack` | `give_back_refused`                                                                                                         |
| `Arrive`   | money reaching the customer's account at the partner                                                                        |

Not covered: the ledger (custodial) branch of `drive` and `partner.pay`, which follow the same pattern and are switched off at launch; the self-freeze check; a crash at any step.

## Last confirmed

Against this branch with the fix for #8597 (based on `origin/main` `83b6b0ff54`), 16 Nov 2026 UTC. Whoever changes a covered function reruns `check-cashout.sh` and updates this line.

## Changing it

Run `check-cashout.sh` once before you change a covered function or the model, and keep the result: a pass then only says the old description still holds. Update the model from the code, never from what makes it pass; when the code breaks a rule, that is a finding. A rule changes only when the promise changes on purpose: the PR gives the old wording, the new wording and the evidence in the change (a doc comment, a test or the commit message). Keep the bounds unless the change makes them wrong, and name any bound you reduce in the PR. The model's update goes in the same PR as the code change. The method in full: [`create-formal-verification-skill`](https://github.com/cursor/plugins/blob/93b916d/pstack/skills/create-formal-verification-skill/SKILL.md) and [`maintain-formal-verification-skill`](https://github.com/cursor/plugins/blob/93b916d/pstack/skills/maintain-formal-verification-skill/SKILL.md).
