# The PayoutQuery model: what it checks and what it covers

`PayoutQuery.tla` is a TLA+ model of one merchant payout on a chain. The payer posts the hold, commits the `dispatched` marker and sends through the chain port (claim the key, sign, journal the signed bytes, broadcast, journal the hash). A reconciler that finds the payout dispatched with no answer asks the chain port about the key and, on `not_sent`, gives the held money back and marks the settlement failed. Both take the payout's session lock. The payer's body runs on the lock's own connection, so a dropped connection frees the lock without the payer noticing while it is inside the rail call. The payer can also die at any step and be retried once. The TLC model checker tries every order of those steps against these rules:

- **NeverPaidTwice** (the promise): a payout is never both sent and given back.
- **ReversedOnce**: the money goes back once.
- **SignedOnce**: one transaction is signed for the key.

## Run it

```
services/svc-pay/model/check.sh
```

It needs Java 11 or later (`java` on the PATH, or `JAVA=/path/to/java`). It downloads the TLA+ tools pinned to v1.7.4 by URL and SHA-256 into `~/.cache/intafaced-tla`. It takes a few seconds. `SHOW_TRACE=1` prints the order of events for each violation.

| Run                        | What                                                            | Expected                                 |
| -------------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| `code-lock-held`           | the code, the lock never lost, the payer dying and retrying     | no error (73 distinct states)            |
| `code-lock-lost`           | the code, the lock's connection may drop, the promise           | **NeverPaidTwice violated**: the finding |
| `code-lock-lost-kept`      | the code, the lock may drop, every other rule                   | no error (142 distinct states)           |
| `fixed-lock-lost`          | the proposed fix, the lock may drop, every rule                 | no error (138 distinct states)           |
| `broken-no-signed-check`   | `lookupSend` ignores the journalled signed bytes                | NeverPaidTwice violated                  |
| `broken-reverse-unkeyed`   | the reverse is not keyed                                        | ReversedOnce violated                    |
| `broken-resign-on-pending` | a retry finding a pending claim signs again instead of stalling | SignedOnce violated                      |

`code-lock-lost` passes the script while the code breaks the promise: it records the finding. When a fix lands it changes to `pass`.

## The finding

`lookupSend` (`rails/evm-chain.ts`) answers `not_sent` whenever the key has no journalled hash and no journalled signed bytes. That is true before the send claims the key and while it is signing, and in both a send can still leave. With the payout's lock lost, the shortest order of events (`SHOW_TRACE=1`): the payer commits `dispatched` and enters the rail call; its lock's connection drops; the reconciler takes the free lock, hears `not_sent`, posts the reverse and marks the settlement failed; the payer then claims the key, signs and broadcasts. The money leaves on the chain and is also back in the merchant's proceeds.

The proposed fix (`Fixed`): `not_sent` closes the key. The status query takes the key's claim itself, with the same `INSERT ... ON CONFLICT DO NOTHING` the send uses. If it wins, nothing was or ever will be sent under that key, and the answer is `not_sent`. If it loses, a send holds the key, and the answer is `unknown` until it has a hash. A send that finds the key closed sends nothing. Answering `unknown` for a pending claim alone was tried first and does not hold: the query can come before the send claims the key.

The same on the real chain port: `src/rails/evm-chain.send.test.ts`, the two tests under the `PayoutQuery.tla` comment.

## What it covers

| Model step                      | Code                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `PLock`, `PMark`                | `payoutSettlement`: `withPayoutLock`, the hold, the `dispatched` marker                        |
| `PClaim`, `PSign`, `PPutSigned` | `runDurableBroadcast`: `store.claim`, `sign`, `putSigned` (`durable-broadcast.ts`)             |
| `PBroadcast`, `PPut`            | `sendRawTransaction`, `store.put`                                                              |
| `PCrash`, `PEnd`                | the payer dying (its lock goes with its connection) and a retry; the call returning            |
| `RLock`, `RQuery`               | `reconcileDispatchedPayout`: `queryPayout` → `lookupSend`; on `not_sent` the reverse, `failed` |
| `LoseLock`                      | the lock's connection dropping while the payer is inside the rail call                         |

Not covered: the rail accepting or refusing (`rail_accepted`, `rail_refused`), depth and settlement, other rails, and the user withdrawal path in `user-money-service.ts`, which takes the same lock and asks the same port.

## At launch

The merchant payout's hold is on a customer account, so `LEDGER_CUSTODY_LAYER` (off by default) refuses it at launch; the same holds for user withdrawals. The finding matters when the custody layer is switched on.

## Last confirmed

Against `origin/main` at `fb28fb1f2a`, 16 Nov 2026. Whoever changes a covered function reruns `check.sh` and updates this line.
