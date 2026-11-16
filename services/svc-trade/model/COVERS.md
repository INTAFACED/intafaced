# The OneHold model: what it checks and what it covers

`OneHold.tla` is a TLA+ model of one resting order's hold: the engine matching part of it, the taker's settlement and the fill consumer writing that fill, and every path that closes the order. The TLC model checker tries every order of those steps, crashes and redeliveries included, against four rules:

- **NoReleaseOfOwed**: money held for an order is never released while the engine has matched part of it and that fill is not settled (#8560).
- **Conservation**: the hold, what was released and what fills drew always add up to the original hold.
- **PaysOnce**: a fill draws from the hold once, however often it is redelivered.
- **EveryFillPaid**: once everything has gone quiet, a fill the engine printed has been paid.

## Run it

```
services/svc-trade/model/check.sh
```

It needs Java 11 or later (`java` on the PATH, or `JAVA=/path/to/java`). It downloads the TLA+ tools pinned to v1.7.4 by URL and SHA-256 into `~/.cache/intafaced-tla`. It exits 0 only when the code passes every rule and each broken variant below fails on the rule it breaks. It takes about 20 seconds (18 s on the Mac, 21 s on a GitHub runner), the download included.

| Run                       | Closers in play                                                         | Expected                           |
| ------------------------- | ----------------------------------------------------------------------- | ---------------------------------- |
| `code-cancel-mass-stp`    | a person's cancel, cancel all, a self-trade pull                        | no error (278,602 distinct states) |
| `code-expiry-sweep`       | a person's cancel, an expiry or IOC remainder, the operator's reconcile | no error (278,602 distinct states) |
| `broken-mass-skips-guard` | cancel all finalizes without the engine's remainder, the #8560 bug      | NoReleaseOfOwed violated           |
| `broken-no-fill-key`      | a fill posts without its `trade.fill:<id>` key                          | PaysOnce violated                  |
| `broken-sum-ignores-rows` | the release ignores fill rows already written                           | NoReleaseOfOwed violated           |

## What it covers

Each step in the model names the code it stands for. A change to any of these is a change to the model's subject: rerun the check, and if the code now does something the model does not, change the model to say what the code does before trusting a pass.

| Model step                                                        | Code (`services/svc-trade/src/spot/`)                                                                                                                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FinLock`, `FinGuard`, `FinSum`, `FinPot`, `FinPost`, `FinStatus` | `trade-service/holds.ts` `finalize` (the row lock, the engine-remainder check, `remainingHold`, the capped release under `order.release:<id>:0`, the status write) and `CancelEvidence` |
| `SettleStart`, `SettleRow`, `SettlePost`, `CrashS`                | `trade-service/fills.ts` `applySubmitResult` → `settleOutcome` → `settleFill` (the fill row, then `tradeFill` under its fill key)                                                       |
| `FC`, `Redeliver`                                                 | `trade-service/events.ts` `settleFillEvent`                                                                                                                                             |
| `CC`, `CCStart`                                                   | `trade-service/events.ts` `releaseOnCancelEvent`                                                                                                                                        |
| `EngineCancel`, `WriteLeft` for `user`                            | `trade-service/order-change.ts` `cancelOrder` (`engine_left_qty`, the first answer only)                                                                                                |
| ... for `mass`                                                    | `trade-service/order-change.ts` `massCancelOrders`                                                                                                                                      |
| ... for `stp`                                                     | `trade-service/fills.ts` `settleOutcome`, a cancellation in a submit's answer                                                                                                           |
| ... for `expiry`                                                  | `ioc-place.ts`, `gtd-gtt-place.ts`, `option-place.ts`, their `settleOutcome` wrappers                                                                                                   |
| ... for `sweep`                                                   | `trade-service/reconcile.ts` `reconcileOrder`, a live order the engine cancels                                                                                                          |
| `Match`                                                           | the engine's book (`services/svc-matching/src/engine/book.ts` `match`), one serial book per market                                                                                      |

The same race on the real services, with a real Postgres: `src/spot/hold-release-race.pg.test.ts`, one test per closer.

Not covered: OCO parents (`finalizeOcoWhenNoLegLive`, `oco-cancel.ts`; their own check is `ocoExecutionSettled`), the hold-unknown paths (`never_on_engine`), paper markets, and the reconcile's engine-miss branch. A full fill whose settlement is still on its way shows no fill row there, so `finalize`'s `engineMissSighted` releases only on a miss first sighted the owner's floor ago with no listing since, and only while `trade.fills` still show no fill; the model has no clock, so that wait is proven by `src/spot/engine-miss-release.pg.test.ts`, not here.

## Last confirmed

Against the code at commit `4ebebd61dd` (intafaced #8563, on `main` at `c0d0e611ee`), 16 Nov 2026. Whoever changes a covered function reruns `check.sh` and updates this line.

## Extending it

A new closer is a new name in `Closers` and a `LeftOf` entry for the remainder it passes. A new rule is a new invariant in the `INVARIANTS` line of `check.sh`, together with a broken variant shown failing on it. Do not weaken a rule or the model until it passes: a violation is a finding, and its trace is the order of events for a failing test.
