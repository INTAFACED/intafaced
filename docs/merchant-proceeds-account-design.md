# Merchant proceeds account

Design only. No recipe, flag, or migration in this change.

Settlement today credits the merchant owner's personal available balance. Card spend, bank transfer, and trading spend that same balance. A payout cap on the owner's withdrawal cannot see those other exits. The fix is a second ledger account that only pay's settlement, refund, chargeback, and payout recipes name.

This is not a new fee, cap, reserve percent, or hold period. Those stay unset until an owner publishes them. `PAY_MERCHANT_CONTROLS` stays the default-off switch for caps and maker-checker. It does not gate this account. A flag whose off state still credits `userAvailable` would keep the hole.

## Accounts

One book. Constructors stay in `packages/ledger-client/src/accounts.ts`, next to `merchantClearing`.

| Account     | Constructor                                                     | Identity                                                                 | What it holds                                      |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| Clearing    | `merchantClearing(merchantId, assetId)`                         | `module` / `pay:clearing:<merchantId>` / `available`                     | Captured, not yet settled. Unchanged.              |
| Proceeds    | `merchantProceeds(merchantId, assetId)`                         | `module` / `pay:proceeds:<merchantId>` / `available`                     | Settled net. The merchant's spendable pay balance. |
| Payout hold | `merchantProceedsPayoutHold(merchantId, assetId, withdrawalId)` | same owner as proceeds, `kind: 'hold'`, `purpose: payout:<withdrawalId>` | One in-flight payout.                              |

`merchantId` is the pay merchant id, not the owner's user id. Two merchants of one person do not share a pot. The owner id matches the platform slug rule already used by clearing (`pay:clearing:<uuid>`): lowercase letter, colon-separated, not a bare UUID. No new `owner_type` and no new `account_kind`. Module accounts are already hard non-negative, so a payout cannot overdraw proceeds into another merchant's pot or into the owner's trading balance.

The payout hold sits on the proceeds owner, not on the user. `assertPairedLocks` funds a hold only from the same owner's available balance in the same transaction. Crediting proceeds and debiting a user `withdrawalHoldAccount` is an unfunded lock: the hold's owner is the user, and the ledger refuses the post. Proceeds cannot be parked in the user's withdrawal hold, where `withdrawSettle` would send them out as a personal withdrawal.

Do not add a bank space whose `accountForSpace` returns proceeds. Spaces stay `userAvailable` (primary) or `subAccountAvailable` (named). `bankTransfer` will move any two available accounts it is given; the closed door is that transfer, card, and trade construct only user and sub-account refs.

There is no sweep recipe from proceeds to `userAvailable`. A later "spend settlement on the card" post would be an exit and has to go through the payout controls. Until that recipe exists, the card cannot see the money.

Rolling reserve stays unwired (`pay.reserve_ledger_unwired`). When a recipe is added, the hold is on the proceeds owner (`purpose: reserve:<id>`), funded from proceeds. No percent and no hold days in that recipe until the owner publishes them.

## Recipes

Debit adds to an account, credit subtracts (`signedDelta`). Personal `withdrawHold` / `withdrawSettle` / `withdrawReverse`, `orderHold`, `deposit`, and `bankTransfer` stay pointed at `userAvailable`. Do not add a `userId` override to `withdrawHold`; a caller could then aim a personal withdrawal at proceeds.

### `merchantSettlement`

Today: credit `merchantClearing` for gross, debit `userAvailable(merchantUserId)` for net, debit `houseFees('pay')` for a positive fee.

After: the net debit is `merchantProceeds(merchantId)`. Gross still leaves clearing. Fee still lands in house fees. Net must stay strictly positive; a fee that swallows the window still refuses. Idempotency key stays `settlement:<merchantId>:<window>:<assetId>`.

`merchantUserId` remains on the input for callers that already pass it, and the recipe stops using it as an account. Dropping it in the same change is fine if every caller is updated together.

### `paymentRefund` and `paymentRefundReverse`

`source: 'clearing'` still uses clearing.

`source: 'settled'` uses proceeds, not `userAvailable(merchantUserId)`. The reverse returns to that same pot. A settled refund that exceeds proceeds fails with insufficient funds. It does not take the shortfall from the owner's personal available balance. Fee policy is unchanged: the refund amount is whatever svc-pay already passes; this design does not invent a "refund the fee" rule.

### `chargebackOpen` and `chargebackWon`

The clearing leg stays on clearing. The leg that is now `userAvailable(merchantUserId)` (`fromMerchantBalance`) moves to proceeds, in both the open and the won recipes, in the same proportions `meta` already records.

`chargebackShortfall` and `chargebackShortfallRecovered` stay on `insuranceFund`. They do not debit `userAvailable`.

svc-pay `openChargeback` reads `merchantBalance` for the settled leg. That read becomes proceeds (below). If clearing plus proceeds cannot cover the dispute, the existing refusal stands and the shortfall recipe is the only cover. Taking the rest from the owner's trading balance is a policy choice and is not part of this design.

### Payout trio

New recipes, used by `settlementLedgerPlan` in `services/svc-pay/src/settlement-ledger.ts`. Same shape as the personal withdrawal trio, different accounts:

| Step                            | Movement                                                               |
| ------------------------------- | ---------------------------------------------------------------------- |
| `merchantProceedsPayoutHold`    | credit proceeds, debit `merchantProceedsPayoutHold` for `withdrawalId` |
| `merchantProceedsPayoutSettle`  | credit that hold, debit `railBoundary(rail)`                           |
| `merchantProceedsPayoutReverse` | credit that hold, debit proceeds                                       |

`withdrawalId` stays `${settlementId}:${payoutAttempt}` so a retry is a new hold. Settle and reverse name the hold, not the whole proceeds balance. A reverse that debited `userAvailable` would move merchant money onto the personal book; the recipe must not do that.

`settlementLedgerPlan` passes `merchantId`. It stops composing `recipes.withdrawHold`.

### Reads

`PaymentService.clearingBalance` stays on clearing.

`PaymentService.merchantBalance` today reads `userAvailable(merchant.userId)` and is documented as the balance the merchant trades from. After the cutover it reads `merchantProceeds(merchantId)`. Callers that show "what this merchant can pay out" follow that read. Callers that show the person's trading balance keep reading `userAvailable` and must not be switched.

The ledger `balance` call is service-to-service. The procedure that returns this number to a person stays the existing merchant read: the caller owns the merchant or is on its team. A founder sees it only through a founder procedure. This design adds no public balance dump.

### Controls

`beforePayoutAdmit` stays on merchant payout, and the payout now debits proceeds. Caps, beneficiary limits, and maker-checker stay behind `PAY_MERCHANT_CONTROLS` (default off). Off means those checks are no-ops. It does not mean settlement credits `userAvailable`.

`beforeUserMoneyWithdrawal` exists because settlement lands on `userAvailable(merchant.userId)`, so a payout halt or cap has to watch the owner's personal withdrawal. After proceeds is the only settlement credit, that hook no longer protects merchant money. Leave it in place until the payout path is debiting proceeds, then stop applying merchant payout caps to `withdrawal.create` on `userAvailable`. Otherwise a merchant's own deposits stay under a payout policy that can no longer see settlement. Doing the unhook in the same change as the recipe avoids a window where payouts leave proceeds with no cap hook and personal withdrawals are still capped for a balance they do not hold.

## Migration

No ledger enum migration. The first `merchantSettlement` after the recipe change upserts the proceeds row. Do not `UPDATE` balances.

Already-posted settlement keys replay the old transaction. They credited `userAvailable`. Replaying them does not move that money. Do not mint a second key to "correct" a window that already settled.

Historical proceeds and personal money are commingled in `userAvailable`. There is no automatic split. A later reclass, if an owner wants one, is a ledger post (credit `userAvailable`, debit proceeds) for one merchant and one asset, amount taken from the journal: settled net minus payouts, settled refunds, and chargeback legs that hit that user available. If that amount is above the live `userAvailable` balance, the post refuses for that merchant. The owner already spent it. Do not claw it back out of card, transfer, or trade history inside the reclass. That post is a money movement: two founders, payload hash bound, default off until the amount source is reviewed. It is not part of the first recipe change.

Cutover order, one change:

1. Add `merchantProceeds` and the payout-hold constructor.
2. Point settlement, settled refund and reverse, chargeback open and won, and `merchantBalance` at proceeds.
3. Point `settlementLedgerPlan` at the payout trio.
4. Drop `beforeUserMoneyWithdrawal`'s merchant-payout coupling once step 3 is in.

Shipping step 2 without step 3 leaves settled net in proceeds and payouts debiting an empty `userAvailable`. Payouts fail closed. Merchants cannot be paid. Ship them together.

## Exits this closes

These doors debit `userAvailable` (or a user hold funded from it) and never name a `pay:proceeds:` owner. Once settlement stops crediting `userAvailable`, they cannot spend merchant net:

| Exit                                           | Where it spends                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Card spend                                     | `svc-bank` `card-service`: `withdrawHold` / `withdrawSettle` / `withdrawReverse` on the cardholder's `userAvailable` |
| Bank transfer, one-off and scheduled           | `transfer-service` → `bankTransfer` → `accountForSpace` (`userAvailable` or `subAccountAvailable`)                   |
| Spot and derivatives order hold, fills, margin | `orderHold`, `tradeFill`, `futuresMarginLock` on `userAvailable`                                                     |
| Personal crypto or fiat withdrawal             | `withdrawHold` on `userAvailable`                                                                                    |
| P2P escrow                                     | `escrowLock` on the user's available                                                                                 |
| Staking and earn                               | `stake`, `earnDeposit` from `userAvailable`                                                                          |
| Sub-account move                               | `subAccountTransfer` between user and sub-account available                                                          |
| Pay to a handle                                | the user-money send, which posts between user available balances                                                     |

Merchant payout is not closed. It moves to the proceeds trio and stays the way settlement leaves the book. Settled refunds and the chargeback settled leg leave through proceeds as well. Those are pay exits, and they are the ones the payout controls can see.

Still open, on purpose:

- Anything that later names `merchantProceeds` as `bankTransfer.from`, or adds a space mapped to it.
- A sweep into `userAvailable`.
- Commingled history already sitting on `userAvailable`.
- A chargeback policy that also debits the owner's personal balance. Not in this design.

## Tests

Amounts in tests stay the fixtures those files already use. No new fee, cap, or reserve figure.

`packages/ledger-client`:

- `merchantSettlement` debits proceeds for net, debits house fees for the fee, credits clearing for gross. `userAvailable` is unchanged.
- Zero or negative net still refuses. A second post with the same merchant, window, and asset returns the first transaction.
- Settled `paymentRefund` credits proceeds. Clearing refunds still credit clearing. Reverse returns to the pot the forward leg used.
- `chargebackOpen` / `chargebackWon` move the settled leg on proceeds. `userAvailable` is unchanged. Shortfall still credits `insuranceFund` only.
- Payout hold increases the module hold and decreases proceeds by the same amount. Settle decreases that hold and the rail boundary. Reverse decreases the hold and increases proceeds. A post that credits proceeds and debits a user withdrawal hold is refused as an unfunded lock.
- Two merchant ids, one user id: two proceeds balances.
- `pay:proceeds:<uuid>` passes `isValidOwnerId('module', …)`. A bare merchant UUID as the owner id does not.

`services/svc-pay` (unit, and the package's existing Postgres tests where the settlement post is already covered):

- A settlement window credits proceeds. The owner's `userAvailable` is unchanged. `merchantBalance` matches proceeds. `clearingBalance` is unchanged.
- A payout hold, settle, and reverse round-trip proceeds and leave `userAvailable` at its prior balance.
- A settled refund that exceeds proceeds fails and does not debit `userAvailable`.
- A chargeback larger than clearing plus proceeds refuses the merchant leg and does not debit `userAvailable`.
- With controls on, `beforePayoutAdmit` still runs for the proceeds payout. A personal `withdrawal.create` is not refused for a merchant payout cap after the unhook.
- A caller who does not own the merchant and is not on its team cannot read `merchantBalance`.

`services/svc-bank` and `services/svc-trade`, one test each if those packages already post against a shared memory ledger in the pay suite; otherwise a pay-side test that posts proceeds and then calls the real `withdrawHold` / `bankTransfer` / `orderHold` builders:

- Proceeds funded, `userAvailable` empty: card `withdrawHold`, `bankTransfer` from the primary space, and `orderHold` each fail insufficient funds. Proceeds is unchanged.

Postgres: start a throwaway `postgresql@16` only in the package that already has ledger PG tests for account identity. Assert the upserted row is `owner_type = module`, `owner_id = pay:proceeds:<merchantId>`, `kind = available`, and a debit past zero fails the non-negative check. No new migration to apply.

## Risks

- Idempotent replay. An old settlement key returns the historical post onto `userAvailable`. A reader who sums proceeds will under-count windows settled before the cutover. Say that in the merchant balance, or the screen will show a shortfall that is actually still on the personal account.
- Reverse and refund direction. One recipe that still debits or credits `userAvailable` on the settled path puts merchant money back on the personal book, or takes a refund from it.
- `bankTransfer` is account-generic. The closure holds only while every bank caller goes through `accountForSpace`. A new caller that passes `merchantProceeds` reopens the exit without a ledger change.
- `merchantBalance` changes meaning. Any screen or metric that used it as "trading balance" will start showing proceeds. Trading balance remains `userAvailable`.
- Unhook timing. Removing `beforeUserMoneyWithdrawal` before payouts debit proceeds drops the only cap on merchant net. Leaving it after the split caps the wrong balance.
- Chargeback personal recourse. If a later change "helps" a shortfall by debiting `userAvailable`, card and trading funds become dispute collateral. That needs an explicit owner decision.
- Historical reclass. A journal sum that double-counts a refund, or that ignores a payout, moves the wrong amount. Refuse when the figure exceeds live available. Do not repair by editing `ledger.accounts.balance`.
- Reserve. Booking a future reserve on `userAvailable` recreates a hold the card does not see and a hole the payout does not see. The hold belongs on the proceeds owner.
- Affiliate accrue runs after `merchantSettlement` and does not post. It must keep not posting. The credit-account change is not a reason to pay the affiliate from proceeds.
