# The PayoutQuery model: what it checks and what it covers

`PayoutQuery.tla` is a TLA+ model of one merchant payout on a chain. The payer posts the hold, commits the `dispatched` marker and sends through the chain port (claim the key, sign, journal the signed bytes, broadcast, journal the hash). A reconciler that finds the payout dispatched with no answer asks the chain port about the key and, on `not_sent`, gives the held money back and marks the settlement failed. Both take the payout's session lock. The payer's body runs on the lock's own connection, so a dropped connection frees the lock without the payer noticing while it is inside the rail call. The payer can also die at any step and be retried once; after that, a later retry of the payout resumes journalled signed bytes (`PRetry`). The TLC model checker tries every order of those steps against these rules:

- **NeverPaidTwice** (the promise): a payout is never both sent and given back.
- **ReversedOnce**: the money goes back once.
- **SignedOnce**: one transaction is signed for the key.
- **No dead end** (TLC's deadlock check, on in every run): the only state with no step out is `Done`, both stopped and the held money answered (hashed, given back, or never held). The `before-8828-ends` run keeps the dead end #8828 fixed.

## Run it

```
services/svc-pay/model/check.sh
```

It needs Java 11 or later (`java` on the PATH, or `JAVA=/path/to/java`). It downloads the TLA+ tools pinned to v1.7.4 by URL and SHA-256 into `~/.cache/intafaced-tla`. It takes a few seconds. `SHOW_TRACE=1` prints the order of events for each violation.

| Run                              | What                                                            | Expected                                 |
| -------------------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| `code-lock-held`                 | the code, the lock never lost, the payer dying and retrying     | no error                                 |
| `code-lock-lost`                 | the code, the lock's connection may drop, every rule            | no error                                 |
| `before-8828-ends`               | before #8828 (`TakesPending = FALSE`): a claimed key is unknown | **deadlock reached**: the #8828 finding  |
| `open-lock-held`                 | before #8604 (`not_sent` left the key open), the lock held      | no error                                 |
| `open-lock-lost`                 | before #8604, the lock may drop, the promise                    | **NeverPaidTwice violated**: the finding |
| `open-lock-lost-kept`            | before #8604, the lock may drop, every other rule               | no error                                 |
| `broken-no-signed-check`         | `lookupSend` ignores the journalled signed bytes                | NeverPaidTwice violated                  |
| `broken-reverse-unkeyed`         | the reverse is not keyed                                        | ReversedOnce violated                    |
| `broken-resign-on-pending`       | a retry finding a pending claim signs again instead of stalling | SignedOnce violated                      |
| `broken-putsigned-ignores-close` | `putSigned` does not need the pending claim, the lock may drop  | NeverPaidTwice violated                  |

The `open-*` runs keep the finding: the code before the fix breaks the promise once the lock can drop.

## The finding (fixed, #8604)

Before the fix, `lookupSend` (`rails/evm-chain.ts`) answered `not_sent` whenever the key has no journalled hash and no journalled signed bytes. That was true before the send claims the key and while it is signing, and in both a send can still leave. With the payout's lock lost, the shortest order of events (`SHOW_TRACE=1`): the payer commits `dispatched` and enters the rail call; its lock's connection drops; the reconciler takes the free lock, hears `not_sent`, posts the reverse and marks the settlement failed; the payer then claims the key, signs and broadcasts. The money leaves on the chain and is also back in the merchant's proceeds.

The fix (`Fixed = TRUE`, now the code): `not_sent` closes the key (`BroadcastStore.close`, `rails/broadcast-store.ts`). The status query takes the key's claim itself, with the same `INSERT ... ON CONFLICT DO NOTHING` the send uses. If it wins, nothing was or ever will be sent under that key, and the answer is `not_sent`. If it loses, a send holds the key, and the answer is `unknown` until it has a hash. A send that finds the key closed sends nothing (`claim` answers `closed`, `runDurableBroadcast` throws `BroadcastClosedError`). Answering `unknown` for a pending claim alone was tried first and does not hold: the query can come before the send claims the key.

The same on the real chain port: `src/rails/evm-chain.send.test.ts`, the two tests under the `PayoutQuery.tla` comment.

## The dead end (fixed, #8828)

Before the fix (`TakesPending = FALSE`, run `before-8828-ends`, `SHOW_TRACE=1`): the payer posts the hold, commits `dispatched` and claims the key; it dies (or its signer throws) before journalling signed bytes; its retry's claim finds the key pending with nothing journalled and stalls; the reconciler hears `unknown`, because a send holds the key, and the hold stays. No step leads out.

The fix (`TakesPending = TRUE`, now the code): `close` also takes a claim that has no signed bytes yet (`UPDATE … SET tx_hash = '__closed__' WHERE tx_hash = '__pending__' AND signed_raw IS NULL`, `rails/broadcast-store.ts`), and the answer is `not_sent`. That is safe whether the sender is gone or only slow, because `putSigned` needs the pending claim: a send still signing fails there and broadcasts nothing (`broken-putsigned-ignores-close` shows the promise breaks without that). Signed bytes journalled: `held`, `unknown`, as before. The same on the real chain port: `src/rails/evm-chain.send.test.ts`, the test of a signer that failed before anything was journalled.

A `not_sent` answer carries `KeyClosed`, a value only `BroadcastStore.close` makes (`ChainSendLookup` in `rails/chain-port.ts`), so a chain port cannot answer `not_sent` without closing the key: #8604's mistake no longer compiles.

## What it covers

| Model step                      | Code                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PLock`, `PMark`                | `payoutSettlement`: `withPayoutLock`, the hold, the `dispatched` marker                                        |
| `PClaim`, `PSign`, `PPutSigned` | `runDurableBroadcast`: `store.claim`, `sign`, `putSigned` (`durable-broadcast.ts`)                             |
| `PBroadcast`, `PPut`            | `sendRawTransaction`, `store.put`                                                                              |
| `PCrash`, `PEnd`, `PRetry`      | the payer dying (its lock goes with its connection) and a retry; the call returning; a later retry resuming    |
| `RLock`, `RQuery`               | `reconcileDispatchedPayout`: `queryPayout` → `lookupSend` (`store.close`); on `not_sent` the reverse, `failed` |
| `LoseLock`                      | the lock's connection dropping while the payer is inside the rail call                                         |

Not covered: the rail accepting or refusing (`rail_accepted`, `rail_refused`), depth and settlement, other rails, and the user withdrawal path in `user-money-service.ts`, which takes the same lock and asks the same port.

## At launch

The merchant payout's hold is on a customer account, so `LEDGER_CUSTODY_LAYER` (off by default) refuses it at launch; the same holds for user withdrawals. The finding matters when the custody layer is switched on.

## Last confirmed

Against the #8828 fix on `fix/ps-3050`, 18 Nov 2026 (`check.sh`, TLC 1.7.4, Java 21: every run as expected). Whoever changes a covered function reruns `check.sh` and updates this line.
