# The PayoutQuery model: what it checks and what it covers

`PayoutQuery.tla` is a TLA+ model of one merchant payout on a chain. The payer posts the hold, commits the `dispatched` marker and sends through the chain port (claim the key, sign, journal the signed bytes, broadcast, journal the hash). A reconciler that finds the payout dispatched with no answer asks the chain port about the key and, on `not_sent`, gives the held money back and marks the settlement failed. Both take the payout's session lock. The payer's body runs on the lock's own connection, so a dropped connection frees the lock without the payer noticing while it is inside the rail call. The payer can also die at any step and be retried once. The TLC model checker tries every order of those steps against these rules:

- **NeverPaidTwice** (the promise): a payout is never both sent and given back.
- **ReversedOnce**: the money goes back once.
- **SignedOnce**: one transaction is signed for the key.
- **No dead end** (TLC's deadlock check): the only state with no step out is `Done`, both stopped and the held money answered (hashed, given back, or never held). The `code-ends` run finds an open dead end today (#8828), so the other runs keep the check off until it is fixed.

## Run it

```
services/svc-pay/model/check.sh
```

It needs Java 11 or later (`java` on the PATH, or `JAVA=/path/to/java`). It downloads the TLA+ tools pinned to v1.7.4 by URL and SHA-256 into `~/.cache/intafaced-tla`. It takes a few seconds. `SHOW_TRACE=1` prints the order of events for each violation.

| Run                        | What                                                            | Expected                                 |
| -------------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| `code-ends`                | the code with the deadlock check on                             | **deadlock reached**: the open #8828     |
| `code-lock-held`           | the code, the lock never lost, the payer dying and retrying     | no error                                 |
| `code-lock-lost`           | the code, the lock's connection may drop, every rule            | no error                                 |
| `open-lock-held`           | before #8604 (`not_sent` left the key open), the lock held      | no error                                 |
| `open-lock-lost`           | before #8604, the lock may drop, the promise                    | **NeverPaidTwice violated**: the finding |
| `open-lock-lost-kept`      | before #8604, the lock may drop, every other rule               | no error                                 |
| `broken-no-signed-check`   | `lookupSend` ignores the journalled signed bytes                | NeverPaidTwice violated                  |
| `broken-reverse-unkeyed`   | the reverse is not keyed                                        | ReversedOnce violated                    |
| `broken-resign-on-pending` | a retry finding a pending claim signs again instead of stalling | SignedOnce violated                      |

The `open-*` runs keep the finding: the code before the fix breaks the promise once the lock can drop.

## The finding (fixed, #8604)

Before the fix, `lookupSend` (`rails/evm-chain.ts`) answered `not_sent` whenever the key has no journalled hash and no journalled signed bytes. That was true before the send claims the key and while it is signing, and in both a send can still leave. With the payout's lock lost, the shortest order of events (`SHOW_TRACE=1`): the payer commits `dispatched` and enters the rail call; its lock's connection drops; the reconciler takes the free lock, hears `not_sent`, posts the reverse and marks the settlement failed; the payer then claims the key, signs and broadcasts. The money leaves on the chain and is also back in the merchant's proceeds.

The fix (`Fixed = TRUE`, now the code): `not_sent` closes the key (`BroadcastStore.close`, `rails/broadcast-store.ts`). The status query takes the key's claim itself, with the same `INSERT ... ON CONFLICT DO NOTHING` the send uses. If it wins, nothing was or ever will be sent under that key, and the answer is `not_sent`. If it loses, a send holds the key, and the answer is `unknown` until it has a hash. A send that finds the key closed sends nothing (`claim` answers `closed`, `runDurableBroadcast` throws `BroadcastClosedError`). Answering `unknown` for a pending claim alone was tried first and does not hold: the query can come before the send claims the key.

The same on the real chain port: `src/rails/evm-chain.send.test.ts`, the two tests under the `PayoutQuery.tla` comment.

## The open dead end (#8828)

With the deadlock check on, the shortest order of events (`SHOW_TRACE=1`): the payer posts the hold, commits `dispatched` and claims the key; it dies (or its signer throws) before journalling signed bytes; its retry's claim finds the key pending with nothing journalled and stalls; the reconciler hears `unknown`, because a send holds the key, and the hold stays. No step leads out: nothing was sent, and nothing can ever answer `not_sent`. The same on the real chain port: the failing test in #8828.

When #8828 is fixed, `code-ends` expects `pass` and every run drops `DEADLOCK=FALSE`. The next dead end TLC then shows is the model's own bound, not the code: with signed bytes journalled and the payer out of its one retry, the hold stays until a later retry of the payout resumes those bytes (`claim` answers `resume`). Model a further retry rather than widening `Done`.

## What it covers

| Model step                      | Code                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PLock`, `PMark`                | `payoutSettlement`: `withPayoutLock`, the hold, the `dispatched` marker                                        |
| `PClaim`, `PSign`, `PPutSigned` | `runDurableBroadcast`: `store.claim`, `sign`, `putSigned` (`durable-broadcast.ts`)                             |
| `PBroadcast`, `PPut`            | `sendRawTransaction`, `store.put`                                                                              |
| `PCrash`, `PEnd`                | the payer dying (its lock goes with its connection) and a retry; the call returning                            |
| `RLock`, `RQuery`               | `reconcileDispatchedPayout`: `queryPayout` → `lookupSend` (`store.close`); on `not_sent` the reverse, `failed` |
| `LoseLock`                      | the lock's connection dropping while the payer is inside the rail call                                         |

Not covered: the rail accepting or refusing (`rail_accepted`, `rail_refused`), depth and settlement, other rails, and the user withdrawal path in `user-money-service.ts`, which takes the same lock and asks the same port.

## At launch

The merchant payout's hold is on a customer account, so `LEDGER_CUSTODY_LAYER` (off by default) refuses it at launch; the same holds for user withdrawals. The finding matters when the custody layer is switched on.

## Last confirmed

Against the fix on #8602, 17 Nov 2026 (the Model check job on that PR's head). Whoever changes a covered function reruns `check.sh` and updates this line.
