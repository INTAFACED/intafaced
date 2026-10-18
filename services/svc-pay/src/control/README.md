# W1 merchant control room (svc-pay)

Tiers, caps, layered pricing, reserves and payout maker-checker. Behind `PAY_MERCHANT_CONTROLS=off|required`
(default `off`; `off` makes every hook a no-op). Guards live in `guards.ts`, registered by
`seams/slots/w1-control.ts`. All numbers in tests are TEST VALUES.

## How each control is enforced

| Control                                               | Where                                                                                                                                  | Notes                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Intake caps (daily, monthly)                          | Create refuses read-only when the headroom is already used. Counted at capture, in `afterPaymentCaptureBooked`, after the ledger post. | A created payment is not volume: public checkout lets anyone create one.       |
| Per-payment cap                                       | Create (single-payment bound, no counter).                                                                                             | At capture it only flags.                                                      |
| Pricing band volume                                   | Captured volume. The pricing snapshot is written at capture.                                                                           |                                                                                |
| Daily payout cap, beneficiary cap, approval threshold | `beforePayoutAdmit` on a proceeds payout, and `beforeUserMoneyWithdrawal` while the owner still has a legacy settlement of that asset. | Merchant owners only. Counted once per settlement (or withdrawal) per UTC day. |
| Maker-checker                                         | `ApprovalService` plus `requirePayoutApproval`. Approver is `payout.approve` on the merchant team (owner, admin, finance).             |                                                                                |

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

## Settlement credit

Settlement credits `merchantProceeds(merchantId)`, not `userAvailable(merchant.userId)`. The payout trio debits
that pot, and `beforePayoutAdmit` is the cap, beneficiary, and maker-checker hook for a proceeds payout.
Personal `withdrawal.create` is held to those caps only while the owner still has a pre-cutover settlement of
that asset: the ledger transaction `settlement:<merchant>:<window>:<asset>` debits `userAvailable`. A merchant
whose posted windows all debit proceeds is skipped, so the owner's own deposits are not capped for a balance
the payout no longer draws.

Card spend, bank transfer, trading, P2P, stake, earn, sub-account moves, and pay-by-handle still debit
`userAvailable` (or a hold funded from it). They do not name `pay:proceeds:`. Windows settled before this
account existed stay on the personal balance; this change does not split that history.

`beforeUserMoneyWithdrawal` remains on the seam for treasury exposure. It applies merchant payout policy (the daily
payout cap included) only to a user who owns a merchant that still has a legacy settlement of the asset being
withdrawn. Any other user's withdrawal meets no per-customer cap. A global payout halt still
refuses every personal withdrawal, including a recovery that would call the rail.

## Boot rule

`PAY_MERCHANT_CONTROLS` has no default. Unset, blank or `off` refuses boot (`pay.merchant_controls_unset`,
`pay.merchant_controls_off_refused`) unless `APP_ENV` is exactly `dev` or `test` (the raw value; an unset `APP_ENV`
is a real deployment). `required` is the value for every real deployment and is a release gate. Any other value
fails boot everywhere. The guard registry applies the same rule, so it cannot fall back to `off` either.

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
6. Ops: watch `pay.control_audit` for `payment.captured_over_cap` (`founderAdmin.control.audit.list`).
7. Approval lists return a masked destination and the rail, derived from the stored payout payload. They do not
   return the full destination. `founderAdmin.approvals.destination` is the one founder-only read of the exact
   address, and each read appends `payout.destination_read` on `pay.control_audit`. The founder queue also returns
   `founderFirstUserId` once one founder has confirmed.
8. Boot: with `required`, `APP_ENV` and the variable are both set on the host. Confirm svc-pay boots; an unset or
   `off` value on a non-dev host is refused at start, not at the first payout.
9. Prove it on the stack you are enabling: request a payout at or above the approval threshold with no approval and
   expect `pay.approval_required` with no row in `pay.payout_admissions`; after a different team member approves,
   expect one `payout.approval_consumed` audit row and the payout admitted once.
