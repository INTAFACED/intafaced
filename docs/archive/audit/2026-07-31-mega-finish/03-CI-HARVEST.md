# 03 — CI / money-suite harvest (finish fire)

**UTC:** 2026-07-31  
**Local:** no Docker/Postgres on audit host — money PG + anvil suites skip (see `01-L0.md`).

## Fleet proof (GitHub Actions on related tips)

| PR                                    | State  | Doctrine  | Build   | Tests   | DoD     | Notes                            |
| ------------------------------------- | ------ | --------- | ------- | ------- | ------- | -------------------------------- |
| **#255** ledger-client rehydrate      | MERGED | SUCCESS   | SUCCESS | SUCCESS | SUCCESS | money-class fleet green baseline |
| **#259** identity freeze-refresh test | MERGED | SUCCESS   | SUCCESS | SUCCESS | SUCCESS | identity path green              |
| **#252** bank B-01 + M226-03          | MERGED | SUCCESS   | FAILURE | SUCCESS | SKIPPED | build flake history; tests green |
| **#271** futures margin recipes       | MERGED | SUCCESS   | FAILURE | SUCCESS | SKIPPED | tip freeze at finish start       |
| **#266** durable BroadcastStore       | OPEN   | FAILURE   | FAILURE | SUCCESS | SKIPPED | owns M226-01; babysit separate   |
| **#274** brand scrub ownership        | OPEN   | (pending) | —       | —       | —       | same scrub included this PR      |

## Honesty rule

Local skip ledger + CI SUCCESS on #255/#259 = **fleet unit proof**, not substitute for multi-replica or live-rail e2e.  
**Not go-live.**
