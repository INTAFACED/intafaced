# Ledger recipe matrix

**62 pure recipes.** Every value path in the OS is a function here. Services call `ledger.post(recipes.<name>(…))` — never assemble entries by hand.

Generated from `src/recipes/index.ts` registry. If this table and the registry disagree, the registry wins and this file is wrong.

| Recipe                          | Module     | Reason                                                           |
| ------------------------------- | ---------- | ---------------------------------------------------------------- |
| `deposit`                       | `ledger`   | `deposit.credited`                                               |
| `marketMakerSeedFund`           | `trade`    | `mm.seed.funded`                                                 |
| `withdrawHold`                  | `ledger`   | `withdraw.held`                                                  |
| `withdrawSettle`                | `ledger`   | `withdraw.settled`                                               |
| `withdrawReverse`               | `ledger`   | `withdraw.reversed`                                              |
| `tradeFill`                     | `trade`    | `trade.fill`                                                     |
| `orderHold`                     | `trade`    | `order.hold`                                                     |
| `orderHoldRelease`              | `trade`    | `order.hold.released`                                            |
| `orderHoldAmend`                | `trade`    | `order.hold.amend`                                               |
| `marketMakerOrderHold`          | `trade`    | `order.hold.mm`                                                  |
| `marketMakerOrderHoldRelease`   | `trade`    | `order.hold.mm.released`                                         |
| `marketMakerMakerFill`          | `trade`    | `trade.fill.mm_maker`                                            |
| `futuresMarginLock`             | `trade`    | `futures.margin.lock`                                            |
| `futuresMarginAdd`              | `trade`    | `futures.margin.add`                                             |
| `futuresMarginRelease`          | `trade`    | `futures.margin.release`                                         |
| `futuresRealizeLoss`            | `trade`    | `futures.loss.realized`                                          |
| `futuresRealizeProfit`          | `trade`    | `futures.profit.realized`                                        |
| `futuresFundingPay`             | `trade`    | `futures.funding.paid`                                           |
| `futuresInsuranceTopup`         | `trade`    | `futures.insurance.topup`                                        |
| `escrowLock`                    | `p2p`      | `p2p.escrow.lock`                                                |
| `escrowRelease`                 | `p2p`      | `p2p.escrow.release`                                             |
| `escrowRefund`                  | `p2p`      | `p2p.escrow.refund`                                              |
| `paymentCapture`                | `pay`      | `payment.captured`                                               |
| `merchantSettlement`            | `pay`      | `pay.settled`                                                    |
| `paymentRefund`                 | `pay`      | `payment.refunded`                                               |
| `paymentRefundReverse`          | `pay`      | `payment.refund.reversed`                                        |
| `merchantProceedsPayoutHold`    | `pay`      | `pay.proceeds.payout.held`                                       |
| `merchantProceedsPayoutSettle`  | `pay`      | `pay.proceeds.payout.settled`                                    |
| `merchantProceedsPayoutReverse` | `pay`      | `pay.proceeds.payout.reversed`                                   |
| `fxConversion`                  | `pay`      | `pay.conversion.booked`                                          |
| `fxConversionReverse`           | `pay`      | `pay.conversion.reversed`                                        |
| `chargebackOpen`                | `pay`      | `pay.chargeback.opened`                                          |
| `chargebackShortfall`           | `pay`      | `pay.chargeback.shortfall.covered`                               |
| `chargebackWon`                 | `pay`      | `pay.chargeback.won`                                             |
| `chargebackShortfallRecovered`  | `pay`      | `pay.chargeback.shortfall.recovered`                             |
| `stake`                         | `token`    | `token.stake`                                                    |
| `unstake`                       | `token`    | `token.unstake`                                                  |
| `mintEmission`                  | `token`    | `token.emission`                                                 |
| `burn`                          | `token`    | `token.burn`                                                     |
| `feeCharge`                     | `token`    | `input.reason ?? 'fee.charged'`                                  |
| `sweepFeesToRewards`            | `token`    | `token.fee.swept`                                                |
| `rewardPay`                     | `token`    | `input.reason`                                                   |
| `loanCollateralLock`            | `bank`     | `loan.collateral.locked`                                         |
| `loanCollateralRelease`         | `bank`     | `loan.collateral.released`                                       |
| `loanDraw`                      | `bank`     | `loan.drawn`                                                     |
| `loanRepay`                     | `bank`     | `loan.repaid`                                                    |
| `loanLiquidate`                 | `bank`     | `loan.liquidated`                                                |
| `loanBadDebt`                   | `bank`     | `loan.bad_debt.covered`                                          |
| `loanReserveFund`               | `bank`     | `loan.reserve.funded`                                            |
| `bankTransfer`                  | `bank`     | `scheduled → bank.transfer.scheduled; else bank.transfer.manual` |
| `earnDeposit`                   | `bank`     | `bank.earn.deposited`                                            |
| `earnWithdraw`                  | `bank`     | `bank.earn.withdrawn`                                            |
| `earnPoolFund`                  | `bank`     | `bank.earn.pool.funded`                                          |
| `earnInterest`                  | `bank`     | `bank.earn.interest`                                             |
| `businessApprovalHold`          | `bank`     | `bank.business.approval.held`                                    |
| `businessApprovalRelease`       | `bank`     | `bank.business.approval.released`                                |
| `businessApprovalSettle`        | `bank`     | `bank.business.approval.settled`                                 |
| `businessPayroll`               | `bank`     | `bank.business.payroll.settled`                                  |
| `subAccountTransfer`            | `identity` | `identity.sub_account.transfer`                                  |
| `marketPurchase`                | `market`   | `market.purchase`                                                |
| `marketListingFee`              | `market`   | `market.listing_fee`                                             |
| `marketPremiumPlacement`        | `market`   | `market.premium_placement`                                       |
## Source files

| File                              | Owns                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/recipes/index.ts`            | core trade / pay / token / futures / escrow / stake + registry                                                                |
| `src/recipes/order-hold-amend.ts` | qty-up extra hold (same pot as `orderHold`; sequenced key)                                                                    |
| `src/recipes/bank.ts`             | transfer + earn + business dual-control holds + atomic payroll                                                                |
| `src/recipes/loans.ts`            | collateral / draw / repay / liquidate / bad debt / reserve                                                                    |
| `src/recipes/chargeback.ts`       | chargeback open / shortfall / won / recovered (explicit §13 sockets; chargebackOpen posted from svc-pay chargeback-ledger.ts) |
| `src/recipes/sub-accounts.ts`     | only legal cross-partition transfer                                                                                           |
| `src/recipes/market.ts`           | purchase + house commission (live); listing fee + premium placement (§13 unwired)                                             |
| `src/recipes/conversion.ts`       | sandbox USD→USDT fill and its reverse (fee and spread to house revenue)                                                       |

## Sealed notes

- **Chargeback** `chargebackOpen`, `chargebackShortfall`, `chargebackWon`, and `chargebackShortfallRecovered` are explicit §13 sockets in `src/recipes/live-path-inventory.ts`, not `live`. `chargebackOpen` is posted from `services/svc-pay/src/chargeback-ledger.ts`.
- **Market listing / premium fees** are §13 unwired (D26-P1-M2): recipes exist so the vendor lifecycle can book owner-published fees without inventing magnitudes; no svc-market writer yet (VendorService moves no value; commerce wire is M1).
- **Market purchase** (`marketPurchase`) is live via svc-market commerce — commission bps still owner-gated upstream.
- Conformance + MemoryLedger prove sum-to-zero; Postgres proves CHECK constraints.
- **orderHoldAmend** is qty-up extra size on the existing `orderHold` pot (sequenced key). Not a second hold. Live via `services/svc-trade/src/spot/qty-up-amend.ts`.
- **D26-P2-11 live-path closure:** every registry key is `live` (production caller) or an explicit §13 socket — machine inventory in `src/recipes/live-path-inventory.ts` (executed by `live-path-inventory.test.ts`). `chargebackOpen`, `chargebackShortfall`, `chargebackWon`, and `chargebackShortfallRecovered` are explicit §13 sockets in that inventory, not `live`. `chargebackOpen` is posted from `services/svc-pay/src/chargeback-ledger.ts`. Do not invent recipes to close a path; socket it.
