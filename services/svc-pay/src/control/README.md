# W1 merchant control room (svc-pay)

Tiers, caps, layered pricing, reserves and payout maker-checker. Behind `PAY_MERCHANT_CONTROLS=off|required`
(default `off`; `off` makes every hook a no-op). Guards live in `guards.ts`, registered by
`seams/slots/w1-control.ts`. All numbers in tests are TEST VALUES.

## How each control is enforced

| Control                                               | Where                                                                                                                                  | Notes                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Intake caps (daily, monthly)                          | Create refuses read-only when the headroom is already used. Counted at capture, in `afterPaymentCaptureBooked`, after the ledger post. | A created payment is not volume: public checkout lets anyone create one. |
| Per-payment cap                                       | Create (single-payment bound, no counter).                                                                                             | At capture it only flags.                                                |
| Pricing band volume                                   | Captured volume. The pricing snapshot is written at capture.                                                                           |                                                                          |
| Daily payout cap, beneficiary cap, approval threshold | `beforePayoutAdmit`, and `beforeUserMoneyWithdrawal` for an owner's withdrawal.                                                        | Counted once per settlement (or withdrawal) per UTC day.                 |
| Maker-checker                                         | `ApprovalService` plus `requirePayoutApproval`. Approver is `payout.approve` on the merchant team (owner, admin, finance).             |                                                                          |

### A capture is never refused by a cap

A capture is classified fresh even when the payer's money has already moved (a rail capture whose ledger post
rolled back, a `captured` webhook, a chain-watcher event). A cap refusal there would strand the money in
`authorized`. So a capture is always counted and, when it goes over a cap, flagged: `pay.control_audit` row with
`kind = 'payment.captured_over_cap'`, `scope_id` = the merchant, `after.paymentId` and `after.exceeded`
(`per_payment`, `daily_intake`, `monthly_intake` or `config_missing`). Ops should watch that kind. Because the
create-time check is the only gate, a cap can be overshot by payments that were created before it filled.

### Locks

The capture counters are taken last in the capture transaction (merchant row, payment row, rail, ledger, then
counters) with a 2s lock timeout, so no counter lock spans a rail or ledger call. A timeout surfaces as
`pay.guard_unavailable` and the retry finishes the capture as a recovery. Payout and withdrawal admissions take
the treasury advisory lock first, then the counters (see `seams/lock-order.db.test.ts`).

## Known residual: the owner's user-money exits that W1 does not hold

Settlement credits a merchant's net to `userAvailable(merchant.userId)`. W1 holds `withdrawal.create` from that
account (`beforeUserMoneyWithdrawal`, only when the owner's merchant has settled that asset). It does NOT hold the
other ways out of the same account:

- svc-bank card spend (`services/svc-bank/src/cards/card-service.ts`, `commitHold`, `withdrawHold` from the user account),
- svc-bank bank transfers (`services/svc-bank/src/transfers/transfer-service.ts`, `bankTransfer` posts, one-off and scheduled),
- trading (the user's available balance is spendable on the exchange).

So the payout bypass is narrowed, not closed. The structural fix is a separate merchant-proceeds account that
settlement credits instead of the owner's personal account, with payout and withdrawal debiting only that account.
Until then the controls cap the one rail W1 can see; do not describe the control room as covering every exit.

## Pre-enable checklist (before setting `PAY_MERCHANT_CONTROLS=required`)

1. Counters and old keys: `SELECT count(*) FROM pay.control_cap_events WHERE event_key LIKE 'payment.create:%'` must be 0. Earlier builds counted intake at create; if any rows exist, reset the intake counters (`pay.control_cap_usage`
   rows of kind `daily_intake` and `monthly_intake`, and their events) so captured volume starts clean.
2. Configuration: every merchant owner with settlements must have a tier with caps (`per_payment`, `daily_intake`,
   `monthly_intake`, `daily_payout`, `beneficiaries_per_day`) and approval and founder thresholds for each asset they
   settled, plus a pricing rule. Unconfigured means refused (`pay.tier_unassigned`, `pay.caps_unconfigured`,
   `pay.approval_threshold_unconfigured`, `pay.pricing_unconfigured`), including for their user-money withdrawals.
3. Team: at least one active `finance` or `admin` member besides the owner, or no payout at or above the threshold
   can be approved (the owner cannot approve their own request).
4. Withdrawals at or above the approval threshold are refused outright (no approval object exists for a withdrawal).
5. Policy note: refunds do not reduce captured volume. A refunded payment still counts against the day and month
   caps and the pricing band. Decide whether that is intended before enabling.
6. Ops: watch `pay.control_audit` for `payment.captured_over_cap`.
