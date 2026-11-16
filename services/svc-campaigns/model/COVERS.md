# The RewardPay model: what it checks and what it covers

`RewardPay.tla` is a TLA+ model of paying owed rewards from our rewards wallet to customers' own wallets on a chain, and booking each payment. Two rewards are owed to one wallet for the same amount, so the chain cannot tell their transfers apart. One or two payer processes run (one service, or two replicas), each can die at any step, and the chain mines, reverts or drops a transfer it took at any time. The TLC model checker tries every order of those steps against these rules:

- **NeverGiveUpOnALiveSend** (the promise): a payment is given up (`failed`, never sent again) only when its transfer can no longer land.
- **OneSendPerReward**: one send per reward, however many payers and crashes.
- **PaidOnAMinedTransfer**, **BookedOnAMinedTransfer**: a reward reads paid, and a payment is booked, only on a transfer that succeeded.
- **OneTransferOneReward**, **BookedOnce**: no transfer pays two rewards, and each is booked under one key.

## Run it

```
services/svc-campaigns/model/check.sh
```

It needs Java 11 or later (`java` on the PATH, or `JAVA=/path/to/java`). It downloads the TLA+ tools pinned to v1.7.4 by URL and SHA-256 into `~/.cache/intafaced-tla`. It takes about a minute on the Mac. `SHOW_TRACE=1` prints the order of events for each violation.

| Run                         | What                                                    | Expected                                         |
| --------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| `code-one-payer`            | the code, one payer, every rule                         | no error (7,305 distinct states)                 |
| `code-two-payers`           | the code, two payers, every rule                        | no error (387,045 distinct states)               |
| `before-fix`                | the code before #8581's fix (the `fix:` line taken out) | **NeverGiveUpOnALiveSend violated**: the finding |
| `broken-no-row-before-send` | no payment row before the send                          | OneSendPerReward violated                        |
| `broken-no-claimed-set`     | `find` may take a hash another reward holds             | OneTransferOneReward violated                    |
| `broken-revert-as-paid`     | a reverted receipt read as success                      | BookedOnAMinedTransfer violated                  |

## The finding, and the fix as coded

Before the fix, the shortest order of events (one payer): the payment row is written; the node takes the send and the answer is lost; the transfer is not mined yet; 60 seconds pass; `settle` finds no transfer on the chain and marks the payment `failed`. The transfer is then mined: the money has left our wallet, the payment is never looked at again (`settleOpen` reads only `sending` and `sent`), the reward stays owed with reason `campaigns.reward_payment_not_taken`, and the ledger never books it. With two payers, the same happens while the first payer's send has not yet reached the node.

The fix in `reward-payer.ts` (#8581), the line tagged `fix:` in the model: a send not found on the chain after `LOST_PAYMENT_AFTER_MS` is never given up. It stays `sending` and is looked for on every pass, never sent again; the reward stays owed with reason `campaigns.reward_payment_unconfirmed` (one `unknown` line), and the payment moves to the back of the open list (`settleOpen` orders by `updated_at`) so it never crowds out payments that can settle. A send the node really never took stays that way until a person looks; before the fix it was `failed` and waited for a person too. A reverted receipt is still `failed`.

The same on the real payer with a real Postgres: `src/reward-payer.pg.test.ts`, the two tests under the `RewardPay.tla` comment, and the rewritten "a send not found on the chain after the wait" test.

## What it covers

| Model step                              | Code (`services/svc-campaigns/src/reward-payer.ts`)                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `StartDue`                              | `payDue`: `due()`, `head()`, the `reward_payments` insert `ON CONFLICT (reward_key) DO NOTHING`                    |
| `SendRefused`, `SendTaken`, `WriteHash` | `payDue`: `chain.send`, its `catch { continue; }`, the `chain_tx ... WHERE chain_tx IS NULL` update                |
| `StartSettle`                           | `settleOpen`: the snapshot of `sending` and `sent` rows                                                            |
| `Find`                                  | `settle`: the claimed hashes, `chain.find`, `LOST_PAYMENT_AFTER_MS`, `unconfirmed`, the `chain_tx` update (UNIQUE) |
| `Receipt`                               | `settle`: `chain.receipt`, `fail` on a revert, the `state = 'sent'` update                                         |
| `Book`, `Mark`                          | `book`: `rewardPayOut` under `campaigns:reward-paid:<chainTx>`, then `booked` and `paid`                           |
| `Crash`, `Tick`, `Land`                 | a process dying, time passing since `sent_at`, the chain mining, reverting or dropping                             |

Not covered: the posting freeze and wallet-balance waits before a send (they send nothing), the ledger refusing a booking (it leaves the payment `sent` and is retried under the same key), a wallet changed after the claim, the network fee, and transfers of different amounts.

## Last confirmed

Against `reward-payer.ts` with #8581's fix, branch `model/reward-payer-late-send` off `origin/main` at `76621e07ff`, 16 Nov 2026. Whoever changes a covered function reruns `check.sh` and updates this line.
