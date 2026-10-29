# Ledger recipe matrix

**85 pure recipes.** Every value path in the OS is a function here. Services call `ledger.post(recipes.<name>(…))` — never assemble entries by hand.

Generated from `src/recipes/index.ts` registry. If this table and the registry disagree, the registry wins and this file is wrong.

| Recipe                          | Module      | Reason                                                           |
| ------------------------------- | ----------- | ---------------------------------------------------------------- |
| `deposit`                       | `ledger`    | `deposit.credited`                                               |
| `depositReverse`                | `ledger`    | `deposit.reversed`                                               |
| `marketMakerSeedFund`           | `trade`     | `mm.seed.funded`                                                 |
| `withdrawHold`                  | `ledger`    | `withdraw.held`                                                  |
| `withdrawSettle`                | `ledger`    | `withdraw.settled`                                               |
| `withdrawReverse`               | `ledger`    | `withdraw.reversed`                                              |
| `withdrawReturned`              | `ledger`    | `withdraw.returned`                                              |
| `tradeFill`                     | `trade`     | `trade.fill`                                                     |
| `tradeFillFeeCorrection`        | `trade`     | `trade.fill.fee.correction`                                      |
| `tradeFillMakerRebate`          | `trade`     | `trade.fill.rebate`                                              |
| `orderHold`                     | `trade`     | `order.hold`                                                     |
| `orderHoldRelease`              | `trade`     | `order.hold.released`                                            |
| `orderHoldAmend`                | `trade`     | `order.hold.amend`                                               |
| `marketMakerOrderHold`          | `trade`     | `order.hold.mm`                                                  |
| `marketMakerOrderHoldRelease`   | `trade`     | `order.hold.mm.released`                                         |
| `marketMakerMakerFill`          | `trade`     | `trade.fill.mm_maker`                                            |
| `futuresMarginLock`             | `trade`     | `futures.margin.lock`                                            |
| `futuresMarginAdd`              | `trade`     | `futures.margin.add`                                             |
| `futuresMarginRelease`          | `trade`     | `futures.margin.release`                                         |
| `futuresOrderMarginHold`        | `trade`     | `futures.order.margin.hold`                                      |
| `futuresOrderMarginRelease`     | `trade`     | `futures.order.margin.release`                                   |
| `futuresOrderMarginApply`       | `trade`     | `futures.order.margin.applied`                                   |
| `futuresRealizeLoss`            | `trade`     | `futures.loss.realized`                                          |
| `futuresRealizeProfit`          | `trade`     | `futures.profit.realized`                                        |
| `futuresFundingPay`             | `trade`     | `futures.funding.paid`                                           |
| `futuresInsuranceTopup`         | `trade`     | `futures.insurance.topup`                                        |
| `escrowLock`                    | `p2p`       | `p2p.escrow.lock`                                                |
| `escrowRelease`                 | `p2p`       | `p2p.escrow.release`                                             |
| `escrowRefund`                  | `p2p`       | `p2p.escrow.refund`                                              |
| `paymentCapture`                | `pay`       | `payment.captured`                                               |
| `merchantSettlement`            | `pay`       | `pay.settled`                                                    |
| `paymentRefund`                 | `pay`       | `payment.refunded`                                               |
| `paymentRefundReverse`          | `pay`       | `payment.refund.reversed`                                        |
| `merchantProceedsPayoutHold`    | `pay`       | `pay.proceeds.payout.held`                                       |
| `merchantProceedsPayoutSettle`  | `pay`       | `pay.proceeds.payout.settled`                                    |
| `merchantProceedsPayoutReverse` | `pay`       | `pay.proceeds.payout.reversed`                                   |
| `fxConversion`                  | `pay`       | `pay.conversion.booked`                                          |
| `fxConversionHold`              | `pay`       | `pay.conversion.held`                                            |
| `fxConversionRelease`           | `pay`       | `pay.conversion.released`                                        |
| `fxConversionReverse`           | `pay`       | `pay.conversion.reversed`                                        |
| `fxConversionLateFill`          | `pay`       | `pay.conversion.late_booked` or `pay.conversion.late_shortfall`  |
| `chargebackOpen`                | `pay`       | `pay.chargeback.opened`                                          |
| `chargebackShortfall`           | `pay`       | `pay.chargeback.shortfall.covered`                               |
| `chargebackWon`                 | `pay`       | `pay.chargeback.won`                                             |
| `chargebackShortfallRecovered`  | `pay`       | `pay.chargeback.shortfall.recovered`                             |
| `stake`                         | `token`     | `token.stake`                                                    |
| `unstake`                       | `token`     | `token.unstake`                                                  |
| `mintEmission`                  | `token`     | `token.emission`                                                 |
| `burn`                          | `token`     | `token.burn`                                                     |
| `feeCharge`                     | `token`     | `input.reason ?? 'fee.charged'`                                  |
| `sweepFeesToRewards`            | `token`     | `token.fee.swept`                                                |
| `rewardPay`                     | `token`     | `input.reason`                                                   |
| `loanCollateralLock`            | `bank`      | `loan.collateral.locked`                                         |
| `loanCollateralRelease`         | `bank`      | `loan.collateral.released`                                       |
| `loanDraw`                      | `bank`      | `loan.drawn`                                                     |
| `loanRepay`                     | `bank`      | `loan.repaid`                                                    |
| `loanLiquidate`                 | `bank`      | `loan.liquidated`                                                |
| `loanBadDebt`                   | `bank`      | `loan.bad_debt.covered`                                          |
| `loanReserveFund`               | `bank`      | `loan.reserve.funded`                                            |
| `bankTransfer`                  | `bank`      | `scheduled → bank.transfer.scheduled; else bank.transfer.manual` |
| `earnDeposit`                   | `bank`      | `bank.earn.deposited`                                            |
| `earnWithdraw`                  | `bank`      | `bank.earn.withdrawn`                                            |
| `earnPoolFund`                  | `bank`      | `bank.earn.pool.funded`                                          |
| `earnInterest`                  | `bank`      | `bank.earn.interest`                                             |
| `businessApprovalHold`          | `bank`      | `bank.business.approval.held`                                    |
| `businessApprovalRelease`       | `bank`      | `bank.business.approval.released`                                |
| `businessApprovalSettle`        | `bank`      | `bank.business.approval.settled`                                 |
| `businessPayroll`               | `bank`      | `bank.business.payroll.settled`                                  |
| `subAccountTransfer`            | `identity`  | `identity.sub_account.transfer`                                  |
| `payReceivedHold`               | `bank`      | `pay.recv.held`                                                  |
| `payReceivedRelease`            | `bank`      | `pay.recv.released`                                              |
| `payReceivedReturn`             | `bank`      | `pay.recv.returned`                                              |
| `bankTransferReversal`          | `bank`      | `bank.transfer.reversed`                                         |
| `staffHoldPlace`                | `ops`       | `ops.hold.placed`                                                |
| `staffHoldRelease`              | `ops`       | `ops.hold.released`                                              |
| `staffHoldConfirm`              | `ops`       | `ops.hold.confirmed`                                             |
| `campaignRewardLock`            | `campaigns` | `campaigns.reward.locked`                                        |
| `campaignRewardUnlock`          | `campaigns` | `campaigns.reward.unlocked`                                      |
| `campaignRewardForfeit`         | `campaigns` | `campaigns.reward.forfeited`                                     |
| `marketPurchase`                | `market`    | `market.purchase`                                                |
| `marketListingFee`              | `market`    | `market.listing_fee`                                             |
| `marketPremiumPlacement`        | `market`    | `market.premium_placement`                                       |
| `marketPurchaseHold`            | `market`    | `market.purchase.held`                                           |
| `marketPurchaseRefund`          | `market`    | `market.purchase.refunded`                                       |
| `marketPurchaseRelease`         | `market`    | `market.purchase.released`                                       |

## Source files

| File                              | Owns                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/recipes/index.ts`            | core trade / pay / token / futures / escrow / stake + registry                                     |
| `src/recipes/order-hold-amend.ts` | qty-up extra hold (same pot as `orderHold`; sequenced key)                                         |
| `src/recipes/bank.ts`             | transfer + earn + business dual-control holds + atomic payroll                                     |
| `src/recipes/loans.ts`            | collateral / draw / repay / liquidate / bad debt / reserve                                         |
| `src/recipes/chargeback.ts`       | chargeback open / shortfall / won / recovered (live; posted from svc-pay chargeback-ledger.ts)     |
| `src/recipes/sub-accounts.ts`     | only legal cross-partition transfer                                                                |
| `src/recipes/market.ts`           | purchase + house commission (live); listing fee + premium placement (§13 unwired)                  |
| `src/recipes/market-escrow.ts`    | held purchase: hold, numbered refunds, release after the window (wired by svc-market next)         |
| `src/recipes/conversion.ts`       | sandbox USD→USDT hold, fill, release, reverse, and late-fill booking from clearing or fx-inventory |
| `src/recipes/staff-hold.ts`       | ops staff holds: place, release in part (approver or expiry), confirm to the owner-named account   |
| `src/recipes/campaign-lock.ts`    | campaign locked rewards and bonuses: rewards engine to a per-reward pot, then unlock or forfeit    |

## Sealed notes

- **Chargeback** `chargebackOpen`, `chargebackShortfall`, `chargebackWon`, and `chargebackShortfallRecovered` are live in `src/recipes/live-path-inventory.ts`. All four are posted from `services/svc-pay/src/chargeback-ledger.ts`. No dispute fee is configured, so none is posted.
- **Market listing / premium fees** are §13 unwired (D26-P1-M2): recipes exist so the vendor lifecycle can book owner-published fees without inventing magnitudes; no svc-market writer yet (VendorService moves no value; commerce wire is M1).
- **Market purchase** (`marketPurchase`) is live via svc-market commerce — commission bps still owner-gated upstream.
- Conformance + MemoryLedger prove sum-to-zero; Postgres proves CHECK constraints.
- **orderHoldAmend** is qty-up extra size on the existing `orderHold` pot (sequenced key). Not a second hold. §13: `services/svc-trade/src/spot/qty-up-amend.ts` only reduces remaining quantity and does not post it.
- **D26-P2-11 live-path closure:** every registry key is `live` (production caller) or an explicit §13 socket — machine inventory in `src/recipes/live-path-inventory.ts` (executed by `live-path-inventory.test.ts`). `chargebackOpen`, `chargebackShortfall`, `chargebackWon`, and `chargebackShortfallRecovered` are live in that inventory. `chargebackOpen` is posted from `services/svc-pay/src/chargeback-ledger.ts`. Do not invent recipes to close a path; socket it.
- **Key spaces for `bankTransfer`:** name the operation with `keySpace` (`own`, `p2p`, `sched`, `rail`). The key is `bank.transfer.<space>:<id>:<occurrence>` (`bankTransferKey`), so two operations can never share a key even if a caller hands them one id. A call with no `keySpace` still posts the legacy `bank.transfer:` key (`legacyBankTransferKey`) and is the collision this closes; new callers always name a space. Read a key back with the builder, never a hand-written string.
- **Lost replies:** one shared classifier, `classifyPostOutcome(err)` → `refused` | `unsent` | `unknown` (`src/post-outcome.ts`), and `provesPostNotCommitted(err)` for "may I release my claim?". The HTTP client stamps how many attempts a failed post took. Only a refusal or failed connect on a single attempt, and the first post ever made under that key, frees the claim. After a retry, or on a re-post under a key already posted once, keep the claim, wait `POST_IN_FLIGHT_BOUND_SECONDS` since the last attempt, and read the key back (`getTxByKey`). `ledger.idempotency_conflict` and every other failure are `unknown`.
