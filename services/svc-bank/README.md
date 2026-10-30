# svc-bank

**Multi-currency accounts over the ledger (§8.1).** Spaces, standing orders, spend analytics, and earn pools.

> §8.1: _"Multi-currency account UX over existing ledger accounts (**no new balance system** — views + rails)."_

**What this service is not:** it is not a wallet, it does not hold balances, and it does not price anything. It stores names, policies, instructions, and records of jobs that already ran. Every "how much" question is answered by `ledger.balance(...)` at the moment it is asked.

Also here: **loans** (§8.1), the **ledger half of cards** (including **custodial JIT conversion** for a settlement asset that is not the funding asset — #1174 / `cards/conversion.ts`), and the **crypto ledger half of ramps**. The card **live rail**, the ramp **fiat leg**, and the **on-chain** half of sovereign-card remain §13 sockets / Shehzad — see [Cards](#cards-what-is-built-and-what-is-a-contract) and [Ramps](#ramps-crypto-ledger-half-vs-fiat-socket).

---

## Where does a balance live?

In svc-ledger. Nowhere else. Concretely:

| Question                             | Answered by                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| How much is in my "Rent" space?      | `ledger.balance(subAccountAvailable(spaceId, asset))`                                                 |
| How much is in my main account?      | `ledger.balance(userAvailable(userId, asset))`                                                        |
| How much have I got earning?         | a sum of `ledger.balance(earnStakeAccount(userId, asset, positionId))` over the user's open positions |
| How big is a pool?                   | a sum of `ledger.balance(earnStakeAccount(userId, asset, positionId))` over the pool's open positions |
| What can a pool still afford to pay? | `ledger.balance(earnPoolReserve(poolId, asset))`                                                      |
| What did I spend last month?         | a fold over ledger entries in the window                                                              |

**A space is a label over a ledger account.** The mapping is one function, `accountForSpace()`:

```
primary space  →  userAvailable(userId, assetId)          (ownerType 'user')
named space    →  subAccountAvailable(spaceId, assetId)   (ownerType 'subaccount')
```

Both account kinds already exist in §4.2. svc-bank adds no account kind, no owner type, and no storage of value — it adds names. That is what "views + rails" means, and it is why "a space's balance equals the ledger's" is true by construction rather than by a reconciliation job somebody could switch off.

### How would someone prove this service has not quietly started keeping its own?

Four ways, in increasing order of strength — all of them are tests that run on every build:

1. **Compare the two answers.** For every space, `spaces.balanceOf()` and `ledger.balance(accountForSpace(space))` must be identical strings. Same for earn: `earn.principalOf(user, asset)` (summed from this service's table) must equal `earn.stakedOf(user, asset)` (read from the ledger), and `earn.interestPaid(pool)` must equal what has actually left the pool reserve.
2. **Close the books.** After a mixed run — transfers, a standing order that fires, one that cannot, an earn deposit and withdrawal, two days of interest — `ledger.totalsByAsset()` is zero for every asset, `reconcile()` is clean, and `verifyChain()` verifies.
3. **Introspect the schema.** A test reads `information_schema.columns` for the `bank` schema and fails on any column name matching `balance`, `total`, `running`, `cached`, `available`, `held`, `accrued`, `outstanding`, … It then requires every `numeric(38,18)` column to be on an explicit allowlist with a written reason. Adding `spaces.balance` turns the build red with the doctrine quoted in the failure.
4. **Prove immutability behaviourally.** Every money column is snapshotted, every money path in the service is exercised, and the snapshot must be byte-identical afterwards. A column that accumulates cannot pass this.

Point 3 is the one that matters most, because it fails for a change nobody has made yet.

---

## API

tRPC, `packages/contracts`. All money crosses the wire as **decimal strings**.

Unconfigured product surfaces refuse without posting: `cards.rewards` names
`bank.rewards_issuer_unset`, `ramps.live` names `bank.live_ramp_unset`, and
`directDeposit` names `bank.no_paycheck_rail`. Loan health refuses
`bank.loan_health_price_unset` when a required price is missing. A simulated
programme never claims live fiat settlement; kind `fiat` refuses
`bank.fiat_ramp_socket` before any row or ledger post.

**Supported assets and networks (W-balances-05).** svc-ledger's registry (`/trpc/assetsList`) is the one list. `assets.list`
(`bank:read`) hands customers every published row, any state: a retired asset stays listed so history that names it still
resolves. The address book offers only active rows that allow withdrawals (`ramps.destinations.networks`), and the deposit
catalogue (`deposits.assets`, `deposits.address`) is narrowed to pairs the registry lists as active, allowing deposits, on that
network: a retired, halted or deposit-less asset takes no new address, not even one issued before. No registry, or an
unreadable one, refuses `bank.asset_registry_unavailable`; custody alone never decides.

**Recipients who cannot receive.** Every credit to another user (`transfers.toUser`,
`transfers.create` to someone else's space, `scheduleToUser` and each standing-order run, business
payroll and proposals) first asks svc-identity (`GET /internal/account/:userId`, service-signed, a
status only, no PII) whether the recipient is active. Frozen, closed and unknown all refuse
`bank.recipient_cannot_receive` with one message, before any ledger post. An identity outage refuses
`bank.recipient_check_unavailable` (retry with the same id; a standing order is not consumed). With no
`IDENTITY_URL`, credits to another user refuse `bank.recipient_check_unset` and the boot log says so;
moves between a user's own spaces are unaffected. A retry of a transfer that already posted still
returns the original.

`spaces.unarchive` restores an archived space without moving value. Funded
archived spaces remain visible. `loans.releaseExcess` requires a caller-supplied
`eventId` so overlapping or repeated requests cannot release collateral twice.

### `spaces`

| Procedure              | Scope                  | Purpose                                                                                                                                                                                              |
| ---------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spaces.list`          | `bank:read`            | Spaces with their **ledger** balances, and the account ref they are a view of                                                                                                                        |
| `spaces.unnamed`       | `bank:read`            | Assets held with no space yet — sourced from the ledger, not this table                                                                                                                              |
| `spaces.create`        | `bank:write`           | New named space (ensures the primary exists first)                                                                                                                                                   |
| `spaces.archive`       | `bank:write`           | Archive a named space. **Moves no value**                                                                                                                                                            |
| `spaces.setGoal`       | `bank:write`           | Set, change or clear the goal of one of the caller’s pots. **Moves no value** (BK-pots-02)                                                                                                           |
| `spaces.setLock`       | `bank:write`           | Lock a pot until a later date, or keep it locked longer; a shorter date refuses `bank.space_change_invalid` (BK-pots-02)                                                                             |
| `spaces.requestUnlock` | `bank:write`           | Early unlock: the pot opens after `BANK_SPACE_UNLOCK_WAIT_HOURS` (blank refuses `bank.space_unlock_rule_unset`); debits refuse until then                                                            |
| `spaces.cancelUnlock`  | `bank:write`           | Withdraw an early unlock still waiting; the pot stays locked to its date                                                                                                                             |
| `spaces.setBillsPot`   | `bank:write`           | Make one of the caller's live pots their bills pot for its asset, with the top-up from the main account on or off (BK-pots-03). Another bills pot of the asset gives the role up. **Moves no value** |
| `spaces.clearBillsPot` | `bank:write`           | The pot stops paying bills; its money stays. Archiving a pot ends the role too                                                                                                                       |
| `spaces.ownedAccounts` | service (svc-tax only) | Every named space the customer ever owned (id, asset, name, archived), so svc-tax can follow own-account moves in the lot book (PF-cost-basis-02). No balance                                        |

A standing order from the caller's bills pot that finds too little is refused `ledger.insufficient_funds` like any other, unless its top-up is on: then the shortfall moves first from the main account into the pot (an own-space `bankTransfer` keyed `bills-fallback:<order>:<pot>` with the occurrence), and the order pays once. When the main account is short too, nothing moves and the run is recorded as refused. An order that pays one of the caller's own spaces is never topped up, and archiving the pot ends its role in the same transaction.

### `transfers`

| Procedure                    | Scope                  | Purpose                                                                                                                                                                                                                                                                               |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transfers.create`           | `bank:write`           | One-off transfer; `transferId` is client-supplied, so a retried request is the same transfer                                                                                                                                                                                          |
| `transfers.schedule`         | `bank:write`           | Standing order — daily, weekly, or monthly — or a one-off (`once`) on a date                                                                                                                                                                                                          |
| `transfers.listSchedules`    | `bank:read`            | The user's standing orders, with the space each pays from and, when it is their own, into (BK-pots-02)                                                                                                                                                                                |
| `transfers.updateSchedule`   | `bank:write`           | Change the amount or end date at the revision read; refused inside the edit cutoff                                                                                                                                                                                                    |
| `transfers.executions`       | `bank:read`            | What ran, what did not, and **why** — the answer to "where is my rent"                                                                                                                                                                                                                |
| `transfers.settleWithdrawal` | service (svc-pay only) | A withdrawal to another person's platform address, settled here (W-withdraw-14): one person-to-person send from the sender's main account under `withdraw:<withdrawal id>`, same limits and freezes; `posted` or `refused` only when nothing posted, any other failure fails the call |
| `transfers.cancel`           | `bank:write`           | Stop future firings. Never reverses ones that happened                                                                                                                                                                                                                                |
| `transfers.pause`            | `bank:write`           | Hold a standing order. The reversible half of `cancel`                                                                                                                                                                                                                                |
| `transfers.resume`           | `bank:write`           | Start it again **from here** — returns the occurrences that will never be made up                                                                                                                                                                                                     |

**Resume does not settle up, and says so on the wire.** `planDue` fires every occurrence between `lastFired` and `now`, which is right after an outage and wrong after a pause: the user stopped the order precisely so those transfers would not happen, and catching up would move three months of rent in one pass on a day nobody chose. So `resume` records the elapsed occurrences as `skipped` — a **row**, not an absence, because `MAX(occurrence)` over `transfer_executions` _is_ `lastFired`, so writing the rows is what moves the schedule's floor forward. The same unique index that makes a double-fire impossible makes a double-skip impossible; there is no second watermark to keep in step. Resuming posts nothing to the ledger, ever.

`skipped` is not `rejected`. Rejected means the ledger refused a real attempt — an empty space — and the user is owed the difference. Skipped means nobody asked. Collapsing them leaves both "why is my space empty" and "why did nothing happen while I was away" unanswerable.

The occurrences that were written off are in the **response**, not merely in the record. A client that renders `status: 'active'` and nothing else lets a user believe the missed months are still coming.

### `earn`

| Procedure              | Scope        | Purpose                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `earn.pools`           | `bank:read`  | Open flexible and fixed pools; refuses `bank.earn_rate_unset` when none are configured                                                                                                                                                                                                   |
| `earn.deposit`         | `bank:write` | Open a position                                                                                                                                                                                                                                                                          |
| `earn.withdraw`        | `bank:write` | Close a position; fixed terms enforced. In a staking-style pool (`unbondingDays`, BK-earn-04) the first take back needs `unbond: true`, starts the unbonding by the bank's clock and moves nothing (without it: `bank.unbond_not_confirmed`; while unbonding: `bank.position_unbonding`) |
| `earn.setAutoRenew`    | `bank:write` | A fixed-term saving's auto-renew choice: the next term starts when this one ends                                                                                                                                                                                                         |
| `earn.positions`       | `bank:read`  | The user's open positions, with `staking` (staked, unbonding, unbonded), `unbondsAt` and the pool's `unbondingDays`                                                                                                                                                                      |
| `earn.riskDisclosure`  | `bank:read`  | The owner's staking risk wording (`BANK_EARN_RISK_WORDING_JSON`: `slashing`, `ownership`); blank or out of shape refuses `bank.earn_risk_wording_unset`, never "no risk"                                                                                                                 |
| `earn.interestHistory` | `bank:read`  | The caller's interest from one pool, a row per paid day (date, that day's rate, their payout, ledger tx), and the sum of every paid day (J-bank-07 #5). Page size required; blank refuses `bank.earn_interest_list_limit_unset`                                                          |

### `loans` — **built.** Collateralised borrow over the ledger (§8.1)

| Procedure             | Scope        | Purpose                                                              |
| --------------------- | ------------ | -------------------------------------------------------------------- |
| `loans.products`      | `bank:read`  | Open products with APR, LTV, margin-call and liquidation thresholds  |
| `loans.open`          | `bank:write` | Lock collateral and draw principal; `loanId` is client-supplied (§5) |
| `loans.list`          | `bank:read`  | The user's loans with outstanding principal/interest derived at read |
| `loans.health`        | `bank:read`  | Portfolio mark — LTV view only; never acts                           |
| `loans.addCollateral` | `bank:write` | Top up collateral (the cheap way out of a margin call)               |
| `loans.repay`         | `bank:write` | Pay interest first, then principal; may close the loan               |
| `loans.close`         | `bank:write` | Release collateral when the loan owes nothing                        |
| `loans.interestRows`  | `bank:read`  | Each accrual day and each approved interest correction, with totals  |
| `loans.ledgerCheck`   | `bank:read`  | This loan's settled rows against the ledger's transactions, per leg  |

Interest **capitalises** (raises debt, posts nothing). A correction is a new `loan_adjustments` row approved by two founders (`ops.adjustLoanInterest`); accrual days and corrections are append-only (LOAN-05). Mark / margin call / liquidation are the risk sweep under `ops`, not user procedures — a user who can choose when collateral is priced can game the staleness window.

### `cards` — **the ledger half. No live card programme: off by default, simulator only.**

The procedures exist and are mounted. With `BANK_CARD_ISSUER=none` (the default) `cards.issue` and `cards.setStatus` refuse with `bank.no_card_issuer` and `cards.programme` answers "No card programme"; with `card-sim` they run against a simulator. No setting selects a real issuer (`CARD_ISSUER_SETTINGS` in `src/cards/issuer.ts`).

| Procedure              | Scope        | Purpose                                                                       |
| ---------------------- | ------------ | ----------------------------------------------------------------------------- |
| `cards.programme`      | `bank:read`  | What this deployment's issuer is — including that it is a **simulator**       |
| `cards.list`           | `bank:read`  | The user's cards. Every row carries `simulated`, never optional               |
| `cards.issue`          | `bank:write` | Issue a card against one of the user's asset balances                         |
| `cards.setStatus`      | `bank:write` | Freeze, unfreeze, close. The gesture a user reaches for first                 |
| `cards.authorizations` | `bank:read`  | Every decision on the card, **approvals and declines alike**, with the reason |

`authorize`, `capture` and `reverse` are **not** here. They are the issuer speaking, not the user — a user who can call `cardAuthorize` approves their own purchase — so they sit in `ops` behind `admin:treasury`. On a live rail they do not become user procedures either; they become a signed webhook owned by the issuer integration.

**None of these do anything until a deployment names an issuer** — see [`BANK_CARD_ISSUER`](#turning-the-card-surface-on-and-what-that-does-not-mean) below. That is the setting, and until it landed there was no setting: `index.ts` passed no issuer, so every deployment ran `noCardIssuer` and refused with a code no operator could act on. The procedures were mounted, scoped and tested, and unreachable — which reads exactly like working, and is the state D-S-15 calls **UNFINISHED**.

**`bank:card` is a real scope and nothing uses it, on purpose.** `packages/auth/src/scopes.ts` defines it, withholds it from every session, and bars it from API keys as "card spend authority — interactive-only step-up surface (§9, §18)". Nothing grants it, because the surface it names — a **user** initiating a card spend — deliberately does not exist here: spend is the issuer's side, and the issuer's side is `admin:treasury`. It becomes live with `socket.live-issuer`, alongside the signed webhook that replaces the three `ops` procedures. Recorded here rather than quietly repurposed for issuance, which is not spend.

### `analytics`

| Procedure         | Scope       | Purpose                                                     |
| ----------------- | ----------- | ----------------------------------------------------------- |
| `analytics.spend` | `bank:read` | Outflow by category over a window, computed from the ledger |

### `autoInvest` — **F-plane half. DCA refuses rates unset.**

| Procedure                         | Scope        | What it does                                                                                                                                                                                                                                                |
| --------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoInvest.list`                 | `bank:read`  | The user's rules. Rules hold **no balance** — instructions only                                                                                                                                                                                             |
| `autoInvest.createThresholdSweep` | `bank:write` | Keep `threshold` in primary available; excess → earn pool (**same asset**, no rate)                                                                                                                                                                         |
| `autoInvest.createRoundUp`        | `bank:write` | Spare change after card capture → same-asset earn pool, or one of the user's own named spaces (`targetSpaceId`, BK-pots-02; exactly one target, else `bank.auto_invest_target_invalid`). Cross-asset `buyAssetId` **refuses `bank.auto_invest_rate_unset`** |
| `autoInvest.createDca`            | `bank:write` | Scheduled cross-asset buy — **refuses `bank.auto_invest_rate_unset`** until a convert port is wired. Never invents §8 rates                                                                                                                                 |
| `autoInvest.pause` / `resume`     | `bank:write` | Hold a rule without cancelling; resume applies normal due rules (no multi-fire invent)                                                                                                                                                                      |
| `autoInvest.cancel`               | `bank:write` | Stop future firings. Does not reverse past runs                                                                                                                                                                                                             |

`ops.runAutoInvest` (`admin:treasury`) and `POST /internal/jobs/run-auto-invest` fire due **threshold / DCA** rules. Card round-ups fire on `ops.cardCapture`, not the runner. Kill switch: `AUTO_INVEST_ENABLED` — same code `bank.auto_invest_disabled` on HTTP, tRPC runner, **and the capture hook**. Sovereign allowance plane is not here — P-plane is `protocol.smart-accounts` (Shehzad). No APY is invented; the destination is an existing earn pool. DCA converts run as a standing instruction: bank calls svc-trade `standing.quote` / `standing.execute` as an authenticated svc-bank (body-bound service call, user and rule id in the signed body, no minted customer principal). The trade door is off until `TRADE_STANDING_INSTRUCTION_ENABLED`; while off, a DCA run refuses `bank.auto_invest_rate_unset`.

### `sorter` — **income sorter (BK-pots-03). Instructions only; blank terms refuse.**

| Procedure       | Scope        | What it does                                                                                                                                                                                                            |
| --------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sorter.list`   | `bank:read`  | The bank's terms (`BANK_INCOME_SORTER_MIN_CREDIT`, or `not_set` with `bank.sorter_terms_unset`) and the caller's live sorters, one per asset at most, each space named and marked `archived` when it was archived since |
| `sorter.runs`   | `bank:read`  | What each sorted payment came to under one of the caller's sorters: every split's amount and `pending`, `settled` or `rejected` with its code                                                                           |
| `sorter.create` | `bank:write` | Shares in whole basis points into the caller's own live named spaces of one asset, at most 10000 in all (`bank.sorter_invalid`); the rest stays in the account. One live sorter per asset (`bank.sorter_exists`)        |
| `sorter.cancel` | `bank:write` | Stop sorting. Payments already sorted stay where they went                                                                                                                                                              |

A payment from another person (`transfers.toUser`, a paid request) is sorted right after it posts, and `POST /internal/jobs/run-income-sorter` sweeps any posted payment the send never sorted and any split whose outcome was unknown. Each split is an own-space `bankTransfer` keyed `sorter:<sorter>:<payment ledger tx>` with the split's position, so a payment is split once whichever path drives it. A refused split (an empty account, an archived space) moves nothing and stays refused. While an earlier post of a split is younger than the ledger's in-flight bound (`POST_IN_FLIGHT_BOUND_SECONDS`), an absent key proves nothing, so the split is neither posted again nor refused until a later sweep.

### `sharedPots` — **shared pots (BK-acct-09). Membership only; blank owner values refuse.**

| Procedure                 | Scope        | What it does                                                                                                                                                                                                      |
| ------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sharedPots.list`         | `bank:read`  | The bank's two values (null when not set), the caller's pots they share with their people and open invites, pots shared with them with the ledger balance, and invites to them not answered                       |
| `sharedPots.invite`       | `bank:write` | Invite an active person by handle or email to one of the caller's live named pots as `viewer` or `contributor`. The invite lasts `BANK_SHARED_POT_INVITE_MINUTES`; the same invite id returns that invite         |
| `sharedPots.cancelInvite` | `bank:write` | The owner withdraws an invite not yet answered, open or expired, so it no longer holds a place                                                                                                                    |
| `sharedPots.accept`       | `bank:write` | Join with the invite's role; past its lifetime refuses `bank.invite_expired`; a pot shared with `BANK_SHARED_POT_PEOPLE_CAP` people (open invites included) refuses `bank.shared_pot_full`                        |
| `sharedPots.decline`      | `bank:write` | Say no to an invite                                                                                                                                                                                               |
| `sharedPots.leave`        | `bank:write` | Stop sharing a pot; the pot and its money stay the owner's                                                                                                                                                        |
| `sharedPots.remove`       | `bank:write` | The owner stops sharing a pot with one member                                                                                                                                                                     |
| `sharedPots.linkCard`     | `bank:write` | The owner links one of their own cards, not closed, to one of their pots so its holders can freeze it. One card per pot and one pot per card                                                                      |
| `sharedPots.unlinkCard`   | `bank:write` | The owner unlinks the pot's card; the card itself is untouched                                                                                                                                                    |
| `sharedPots.freezeCard`   | `bank:write` | The owner or a contributor freezes the pot's linked card (no step-up: it protects); a viewer refuses `bank.space_forbidden`. Only the owner unfreezes, through `cards.setStatus`                                  |
| `sharedPots.activity`     | `bank:read`  | The pot's log, newest first, naming who invited, cancelled an invite, joined, declined, left and was removed, and who linked, unlinked, froze or unfroze its card, by handle; for the owner and the pot's members |

**Moves no value.** A contributor adds money with `transfers.create` into the pot, the same transfer as anyone paying into a space. A viewer doing so, and any member taking money out of a pot they do not own, refuses `bank.space_forbidden`. Either owner value blank refuses `bank.joint_unset` (the slice's decision note: nothing is shared until the owner decides). Handles come from svc-identity's directory (`IDENTITY_URL`).

### `recovery` — **recovery claims (RC-identity-08, J-identity-05 #7). The heir's keys move a dead owner's balances; staff never do.**

| Procedure                 | Scope        | What it does                                                                                                                                                                                                                               |
| ------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recovery.estates`        | `bank:read`  | The accounts the caller may claim as heir, as svc-identity lists them now, each with the free balances a sweep moves (main account per asset and named spaces), the held value that stays until released, and any debt that blocks a sweep |
| `recovery.claims.open`    | `bank:write` | Open the claim on one listed account, or answer the open one again, with the text each recovery key signs (`recoveryClaimMessage`). Moves nothing                                                                                          |
| `recovery.claims.execute` | `bank:write` | Ask identity whether these signatures claim the account for the caller now, then sweep the owner's free balances into the caller's main account in each asset                                                                              |

**Who decides what.** Two staff confirm the death notice in svc-identity, and the owner chose the heir, the keys and how many must sign while alive. svc-bank asks identity (`GET /internal/recovery-claims/estates/:heirUserId`, `POST /internal/recovery-claims/verify`) with the signed-in caller's own id, never an id from input, and keeps only the claim and its sweep plan. An API key or a sub-account refuses `bank.recovery_delegated`; staff (`admin:*`, `support:ops`, `market:ops`) refuse `bank.recovery_staff_forbidden`. Identity refusing the signatures refuses `bank.recovery_claim_refused` with identity's code in the message, and no IDENTITY_URL, or identity not answering, refuses `bank.recovery_unavailable`. Nothing moves in any of these.

**How a sweep posts.** One claim per account (`recovery_claims`, id derived from the account and the confirmed notice). Each round writes one `recovery_sweeps` row per funded account before anything posts, then posts each as `bankTransfer` in the `recovery` key space with the row's key, and marks it posted. A crash in between leaves the row pending, and the next call posts the same key again, which the ledger answers with the first transaction. A ledger refusal that proves nothing posted (funds gone, an entry the ledger will not take, the posting freeze) settles the row refused. Once no row of a round is pending, the claim moves to the next round (the claim reads `executed` only once a sweep has posted), so value that reaches the owner's accounts later is swept by asking again. Value held, staked or pledged (any non-`available` account, or a purposed one) stays where it is: the free value moves without it, and a later round moves it once it is released. A negative balance is a debt, and refuses the whole round with `bank.recovery_blocked` until it is settled. The ledger is read just before the round is planned, outside the claim's lock; value that arrives after the read goes to the next round. The owner's trading sub-accounts in svc-identity are not swept by this slice: their balances stay frozen with the account.

### `business` — **maker/checker with ledger holds. Not full bank-biz.**

| Procedure                      | Scope                  | What it does                                                                                                                                                                                |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `business.list` / `create`     | `bank:read` / `write`  | Corporate account + spend threshold                                                                                                                                                         |
| `business.addMember`           | `bank:write`           | admin/maker/checker roles                                                                                                                                                                   |
| `business.proposeTransfer`     | `bank:write`           | Under threshold posts; at/above → **purposed ledger hold** + pending approval                                                                                                               |
| `business.approve`             | `bank:write`           | Checker (not maker) settles hold → destination                                                                                                                                              |
| `business.reject` / `cancel`   | `bank:write`           | Checker reject or maker/admin cancel — hold returns to debit pot                                                                                                                            |
| `business.pending`             | `bank:read`            | Open approvals (each carries `holdLedgerTxId` while pending)                                                                                                                                |
| `business.approverEligibility` | service (svc-pay only) | May this member approve for the team? `eligible`, `role_cannot_approve`, `not_a_member`, `account_closed` or `no_such_account`; a read, used for multi-approval withdrawals (W-withdraw-11) |

KYB / payroll / invoicing / expense cards remain residual or §13 — not invented here.

Honest residual: KYB (Lane B), expense cards, invoicing (`pay.gateway`), multi-recipient payroll atomicity, dedicated org principal — not invented here.

### `ramps` — **crypto ledger half. Kind fiat refuses before any row or ledger post.**

| Procedure         | Scope        | Purpose                                                                                                                   |
| ----------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `ramps.programme` | `bank:read`  | What this deployment's ramp is — including that it is a ledger sandbox                                                    |
| `ramps.onramps`   | `bank:read`  | The user's on-ramp credits. Every row carries `simulated`                                                                 |
| `ramps.offramps`  | `bank:read`  | The user's off-ramps. Every row carries `simulated`                                                                       |
| `ramps.offramp`   | `bank:write` | Crypto: hold then settle to `bank-crypto-ledger`. Kind fiat refuses before any row or ledger post. Does **not** broadcast |

The customer security lock (W-withdraw-09) belongs to svc-identity; svc-bank reads it per request from `GET /internal/security-lock/:userId` and keeps no copy. While it holds, adding a withdrawal address (`ramps.destinations.check/save`, `ramps.setWithdrawDestination`) and starting a `ramps.offramp` refuse `bank.security_locked` before any row or ledger post; a replay of a save or an off-ramp made before the lock answers as before, and removing an address is not stopped (it only takes a way out away). The owner's self-freeze (I-account-lifecycle-08), read on the same ask from `GET /internal/self-freeze/:userId`, refuses the same actions first, as `bank.account_frozen_self`, on every path that checks the lock (cash-out and personal-pay sends included). It is stricter than the lock for `ramps.offramp`: a send claimed before the freeze does not carry on either (a held one stays held until the owner lifts it), and `ramps.destinations.readiness` answers `locked` with no end. Identity unreachable on either read refuses `bank.security_lock_unavailable`; no `IDENTITY_URL` refuses `bank.security_lock_unset`. `ramps.destinations.readiness` (`bank:read`) answers whether one saved address can be used now, first reason first: `locked`, `blocked`, `cooling_unset`, `cooling` (with its end) or `ready`.

`ramps.destinations.sendable` (service, svc-pay only; `packages/contracts` `bank-send-destination.ts`) is the same readiness asked by address instead of by entry: svc-pay asks it before it claims a withdrawal to a wallet outside the platform (J-wallet-05 #6, issue #6517). Only a saved customer entry of that asset, on that network, for that address (an EVM address in any letter case; an entry with a tag never matches, since a send carries none) answers the book's readiness (`locked`, `blocked`, `approval_pending`, `cooling_unset`, `cooling`, `ready`); the same address saved only on another network is `other_network`, anything else `not_saved`. It reads and never writes; a lock that cannot be read refuses, and svc-pay reads every non-answer as unavailable.

`ops.creditOnramp` (admin:treasury) is the inbound credit for the crypto ledger half — same reason deposit.credit lives under ops in svc-pay: a user who credits themselves does not need a ramp. Kind fiat refuses `bank.fiat_ramp_socket` before any row or ledger post. These tables do not store a fiat onramp or offramp, and kind fiat does not post.

```bash
BANK_RAMP_MODE=none            # default — every ramp money path refuses bank.no_ramp_rail
BANK_RAMP_MODE=crypto-ledger   # ledger half only; simulated: true always
BANK_OFFRAMP_COOLING_HOURS=    # owner-set hours; blank → bank.offramp_cooling_unset (never 24h)
BANK_ADDRESS_BOOK_CAP=         # owner-set saved addresses per customer; blank → bank.address_book_cap_unset
BANK_WALLET_PROOF_WINDOW_MINUTES= # owner-set minutes a wallet ownership proof stays open; blank → bank.wallet_proof_window_unset
BANK_WALLET_PROOF_VALID_DAYS=  # owner-set days a verified wallet proof holds; blank → bank.wallet_proof_validity_unset
BANK_ADDRESS_APPROVAL_LINK_MINUTES= # owner-set minutes an emailed new-address approval link works (≤ 7 days); blank → bank.address_approval_link_unset
BANK_DEPOSIT_ADDRESS_CAP=      # owner-set deposit addresses open at once per asset and network, the first included; blank → bank.deposit_address_cap_unset
BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS= # owner-set days an extra deposit address lasts; blank → bank.deposit_address_expiry_unset
BANK_ACCOUNT_DETAILS_CURRENCIES= # owner-published ISO-4217 list ("GBP,EUR"); blank → bank.account_details_currencies_unset
BANK_ELIGIBILITY_JSON=         # owner-published who can open an account; blank → bank.eligibility_unset
BANK_SEND_FIELD_RULES_JSON=    # owner-published purpose / source-of-funds / reference rules of a global send; blank → bank.send_field_rules_unset
```

### `ops` — operator only

| Procedure                  | Scope            | Purpose                                                                                                                                                                   |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops.runDueTransfers`      | `admin:treasury` | Fire every due standing order                                                                                                                                             |
| `ops.accrueInterest`       | `admin:treasury` | One day's earn interest, one pool or all; a day that has not begun refuses with `bank.accrual_day_not_begun`                                                              |
| `ops.fundPool`             | `admin:treasury` | Move bank revenue into a pool's reserve                                                                                                                                   |
| `ops.fundLoanReserve`      | `admin:treasury` | Top up the debt-asset reserve loans draw from                                                                                                                             |
| `ops.accrueLoanInterest`   | `admin:treasury` | Capitalise loan interest (no ledger post; unique per loan/day)                                                                                                            |
| `ops.runRiskSweep`         | `admin:treasury` | Mark open loans; margin-call and liquidate past grace                                                                                                                     |
| `ops.resumePendingLoans`   | `admin:treasury` | Re-drive loans stuck between collateral lock and principal draw                                                                                                           |
| `ops.resumePendingEarn`    | `admin:treasury` | Re-drive earn deposits stuck pending after ledger post                                                                                                                    |
| `ops.renewEarnTerms`       | `admin:treasury` | Start the next term of ended fixed-term savings with auto-renew on                                                                                                        |
| `ops.setEarnPoolStatus`    | `admin:treasury` | Four-eyes: close a pool to new savings or open it again, keyed `pool-status:<poolId>:<revision>`; unchanged or stale spends no approval                                   |
| `ops.releaseUnbondedEarn`  | job (svc-bank)   | Pay back staking-style savings whose unbonding ended by the bank's clock (no caller time), through `earnWithdraw`; pages by `after`/`next`; a second run releases nothing |
| `ops.abandonPendingLoan`   | `admin:treasury` | Give up on a pending loan and return collateral                                                                                                                           |
| `ops.adjustLoanInterest`   | `admin:treasury` | Four-eyes interest correction: a new signed row with its reason                                                                                                           |
| `ops.cardAuthorize`        | `admin:treasury` | The authorisation "webhook" — decide, and hold if the answer is yes                                                                                                       |
| `ops.cardCapture`          | `admin:treasury` | The merchant took this much; the remainder of the hold goes back                                                                                                          |
| `ops.cardReverse`          | `admin:treasury` | The authorisation expired or was voided; the whole hold goes back                                                                                                         |
| `ops.cardResumeSettlement` | `admin:treasury` | Re-drive a claimed card capture/reversal that never reached ledger                                                                                                        |
| `ops.fundCashbackPot`      | `admin:treasury` | Sweep bank revenue into the pot cashback is paid from                                                                                                                     |
| `ops.creditOnramp`         | `admin:treasury` | Crypto ledger-half on-ramp credit (never user-callable)                                                                                                                   |
| `ops.runAutoInvest`        | `admin:treasury` | Fire due auto-invest rules (threshold sweeps; DCA when convert wired)                                                                                                     |

These jobs are deliberately **not user-callable**: a user who can trigger "run every due transfer" or the risk sweep chooses when other people's money moves (or when their collateral is sold). `admin:treasury` is interactive-only (§4.1), so it can never be held by a long-lived API key.

HTTP, for the external scheduler (service credentials required; each money job has its own kill-switch where relevant):

| Route                                         | What it runs                                                     |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `POST /internal/jobs/run-due-transfers`       | standing orders                                                  |
| `POST /internal/jobs/accrue-interest`         | earn pool daily interest                                         |
| `POST /internal/jobs/accrue-loan-interest`    | loan interest capitalisation                                     |
| `POST /internal/jobs/run-risk-sweep`          | mark / call / liquidate (default **off**)                        |
| `POST /internal/jobs/resume-pending-loans`    | crash recovery for pending loan opens; also ticked in-process    |
| `POST /internal/jobs/recover-loan-repayments` | re-drive unknown repayments/releases; also ticked in-process     |
| `POST /internal/jobs/resume-pending-earn`     | crash recovery for pending earn deposits; also ticked in-process |
| `POST /internal/jobs/run-auto-invest`         | auto-invest threshold sweeps / due DCA                           |
| `POST /internal/jobs/run-income-sorter`       | income sorter: unsorted payments and splits left pending         |

Plus `/health` and `/ready`. Card settlement resume (`ops.cardResumeSettlement`) and fixed-term auto-renew (`ops.renewEarnTerms`) are tRPC-only: the scheduler calls them signed as svc-bank, with no HTTP twin yet.

---

## Events

**Publishes — `intafaced.bank.margin_call.created`. This service owns the `INTAFACED_BANK` stream and creates it at boot.**

One subject, and it was declared in `packages/events` long before anything sent it. `bankMarginCalled` had a schema, and a complete svc-notify consumer, parked on a stream no service had ever created — so a margin call wrote a `loan_margin_calls` row, started a grace clock that gates liquidation, and told the borrower nothing. `loans/risk.ts` argues at length against precisely that outcome — _"the borrower's first notice of the loan would be its liquidation receipt"_ — and it was the live behaviour, because the notice had no transport.

Raising the call and delivering it stay two facts. svc-bank publishes; whether the borrower was reached is svc-notify's answer, recorded per channel, and it is allowed to be "no". A failed publish is written to `loan_margin_calls.notify_error` and does **not** un-call the loan — see `loans/margin-call-publisher.ts`.

Publishing moves no value. Every recipe in the Ledger table below still goes through `packages/ledger-client` and nothing else.

The subjects below are still unwritten, and go in an events PR before svc-bank publishes any of them (`AGENT_PROTOCOL` §1: _"A `packages/contracts` and/or `packages/events` PR that declares the new interface or event. Reviewed on its own. … Never the reverse. Never both at once."_ §2 makes publishing an undeclared subject a hard prohibition):

| Planned subject                    | When                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| `intafaced.bank.space.created`     | a user names a new space                             |
| `intafaced.bank.transfer.settled`  | a standing order fired and settled                   |
| `intafaced.bank.transfer.rejected` | a firing was refused — **the user needs to be told** |
| `intafaced.bank.position.opened`   | an earn position opened                              |
| `intafaced.bank.position.closed`   | an earn position closed                              |
| `intafaced.bank.interest.posted`   | a pool accrued a day of interest                     |

Until then, `transfers.executions` is the queryable record of every firing and every rejection, so nothing is unobservable — it is pull rather than push.

**Consumes** — nothing. Earn pool funding is still an operator action (`ops.fundPool`); loan interest **capitalises** onto the debt and does not auto-fund earn reserves. There is no automatic pipe from loan interest revenue into earn pools.

---

## Ledger

Every recipe this service invokes, and what it touches. Transfer/earn recipes live in `packages/ledger-client/src/recipes/bank.ts`; loan recipes in `packages/ledger-client/src/recipes/loans.ts`. Cards and ramps reuse the shared withdraw/deposit recipes — no second spelling of the same movement.

| Recipe                  | Reason code                | Accounts / effect                                             |
| ----------------------- | -------------------------- | ------------------------------------------------------------- |
| `bankTransfer`          | `bank.transfer.manual`     | space account → space account                                 |
| `bankTransfer`          | `bank.transfer.scheduled`  | space account → space account                                 |
| `bankTransfer`          | `bank.transfer.manual`     | dead owner's free account → heir available (`recovery` keys)  |
| `earnDeposit`           | `bank.earn.deposited`      | user available → user stake                                   |
| `earnWithdraw`          | `bank.earn.withdrawn`      | user stake → user available                                   |
| `earnPoolFund`          | `bank.earn.pool.funded`    | `houseFees('bank')` → `earnPoolReserve(pool)`                 |
| `earnInterest`          | `bank.earn.interest`       | `earnPoolReserve(pool)` → many user available                 |
| `loanCollateralLock`    | `loan.collateral.locked`   | borrower available → purposed collateral (`loan:<id>`)        |
| `loanCollateralRelease` | `loan.collateral.released` | purposed collateral → borrower available                      |
| `loanDraw`              | `loan.drawn`               | `loanReserve(debtAsset)` → borrower available                 |
| `loanRepay`             | `loan.repaid`              | available → reserve (principal) + house (interest)            |
| `loanLiquidate`         | `loan.liquidated`          | collateral → buyer; buyer's cash → reserve + house + borrower |
| `loanBadDebt`           | `loan.bad_debt.covered`    | insurance / house covers unrecovered debt                     |
| `loanReserveFund`       | `loan.reserve.funded`      | fund the debt-asset reserve loans draw from                   |
| `withdrawHold`          | (card auth)                | available → hold per authorisation                            |
| `withdrawSettle`        | (card capture / offramp)   | hold → rail boundary                                          |
| `withdrawReverse`       | (card reverse / remainder) | hold → available                                              |
| `rewardPay`             | (card cashback)            | `rewardsEngine` → available                                   |
| `deposit`               | (crypto on-ramp credit)    | rail boundary → user available                                |

Native staking uses `stake` / `unstake` in svc-token, not here.

### Idempotency keys

Business keys, never UUIDs, never clock readings (§5):

```
bank.transfer.sched:<scheduleId>:<occurrence>        one firing of one standing order
bank.transfer.own:<transferId>:0                     a user moving value between their own spaces
bank.transfer.p2p:<transferId>:0                     a payment to another user (personal pay, a paid request)
bank.transfer.rail:<paymentId>:<0|1>                 a send to a rail boundary (0) and its reversal (1)
bank.transfer.recovery:<claimId>:<account>:<round>   one recovery sweep of one owner account (never reversed by consent)
bank.earn.deposit:<positionId>                       one position opening
bank.earn.withdraw:<positionId>                      one position closing
bank.earn.fund:<poolId>:<fundingId>                  one reserve top-up
bank.interest:<poolId>:<date>                        one day of one pool
bank.loan.collateral.lock:<loanId>:<sequence>        one collateral lock / top-up
bank.loan.collateral.release:<loanId>:<sequence>     one collateral release
bank.loan.draw:<loanId>                              one principal draw
bank.loan.repay:<loanId>:<sequence>                  one repayment
bank.loan.liquidate:<loanId>:<tranche>               one liquidation tranche
bank.loan.baddebt:<loanId>                           one bad-debt cover
bank.loan.reserve.fund:<debtAssetId>:<fundingId>     one reserve top-up
```

`occurrence` is derived from `(startsAt, cadence, n)` — never from a counter. Two workers, a retry, and a catch-up run after an outage all compute the same index for the same intended transfer.

**A key that is already taken is a retry only if the terms match.** `positionId` and `loanId` are client-supplied, so the id alone cannot separate "the same request arriving twice" from "a different request wearing an id somebody has already used" — and `ON CONFLICT (id) DO NOTHING` silently keeps the first row while every guard runs on the new input. Both paths therefore compare before they proceed, and refuse on a mismatch: `bank.position_conflict`, `bank.loan_principal_mismatch`, `bank.loan_collateral_mismatch`, `bank.loan_borrower_mismatch`. Same id + same terms stays idempotent, which is the whole reason the id is the client's to choose.

---

## Coordination with svc-token

§8.1: _"flexible/fixed pools as stake-kind ledger accounts; native staking already lives in svc-token."_

Both services move value into stake accounts for the same user, and there was a
time when that meant the **same ledger account**: `userStake(userId, assetId)`
was one pot per (user, asset), so the two services sharing an asset would have
left neither able to reconcile its own table against the ledger.

**That collision is now structurally impossible, and this section used to say
otherwise.** `purpose` is part of an account's identity — enforced by the unique
index `accounts_identity_purpose_idx` — and `userStake` requires one, throwing
without it. The two services reach it through different constructors:

| Constructor                                 | Purpose            |
| ------------------------------------------- | ------------------ |
| `tokenStakeAccount(user, asset, stakeId)`   | `token:stake:<id>` |
| `earnStakeAccount(user, asset, positionId)` | `bank:earn:<id>`   |

Different purpose, different account — not merely per service but per position,
so two earn positions do not share a pot either. Nothing in this repo can build
an unpurposed stake account: the sweep in `packages/ledger-client/src/accounts.purposed.test.ts`
calls every exported builder and fails on any that returns a lock kind without a
purpose.

svc-bank still refuses the native asset in earn pools
(`bank.native_asset_not_earnable`), and should: the reason is §8.1 — native
staking belongs to svc-token — and not the account collision, which no longer
needs preventing. One asset, one owner. The refusal is tested.

---

## Ordering decisions that matter

**Scheduled transfer: claim, post, settle — one database transaction.**

- crash before the claim commits → nothing happened; the next pass retries.
- crash after the ledger post, before the commit → the database rolls the claim back while the ledger transaction stands. The next pass re-claims and re-posts; the post is idempotent so it returns the **same** transaction and the row is written against it. Money moved once, the record catches up. **Nobody's funds are stranded** — the value is in the destination account the whole time; the only thing missing was our note about it.
- crash after the commit → done.

Holding a database transaction open across the ledger call is a deliberate cost: it is what makes "claimed" and "posted" inseparable. Committing the claim first would create a window where a claimed occurrence has no ledger transaction and no process left alive to make one — a transfer the user was told would happen, that never will. A committed `pending` row is swept explicitly anyway, because that is the one failure that would strand a transfer forever with no error anywhere.

**A stranded claim is its own reason to look at a schedule.** The runner asks two questions, not one: what is due (`status = 'active' AND next_run_at <= now`), and what holds a `pending` row — **whatever its status, whatever its `next_run_at`**. Sweeping used to be a side effect of the schedule coming due again, which was true enough while a schedule was either active or dead. `pause` broke that silently: a paused order is never selected by the due query, so a claim stranded before the pause would sit there for as long as the user left it paused, with nothing raised anywhere. `resume` made it worse, not better — it moves `next_run_at` _past_ the stranded occurrence. Cancelling does not retract a claim either, for the reason cancel is not a reversal. Sweeping plans no new occurrences and advances no `next_run_at`; it finishes what was started and touches nothing else. The count is reported separately as `strandedSwept`, because it is the number an operator wants to be zero and it is invisible in `settled`.

**Advance `next_run_at` last.** If that update is lost, the next pass reconsiders occurrences the executions table already owns and skips them — wasted work, never a double transfer. The other order would let a crash advance past an occurrence that never fired.

**A rejected occurrence is consumed, not queued.** A monthly transfer that failed in March is a March transfer; silently making it up in April would move money the user is no longer expecting to move. The rejection is recorded with its code so the user gets a reason.

**Earn deposit: ledger first, then the row** — same as svc-token's `stake`, same reason. The reverse order would let a position exist with nothing behind it: a position we would pay interest on that nobody funded.

**Interest: claim the UTC day, post, record.** `YYYY-MM-DD` UTC is both the idempotency day and the eligibility boundary. A position must be open before `00:00:00.000Z` for that day; a scheduler running late cannot pay a full day to a position opened after midnight. If the reserve cannot cover the day, **nothing moves** and the claim rolls back so the day is re-runnable the moment the pool is funded. That is the loud failure §8.1 needs — a pool that cannot pay its advertised rate is an operator problem today, not a shortfall discovered at maturity.

**No configured pool means no configured rate, not zero yield.** `earn.pools` and the all-pools accrual door refuse `bank.earn_rate_unset` instead of returning an empty success that makes an unconfigured deployment look live. Individual pool operations still resolve the named pool and use only its stored operator-set APR; svc-bank has no default APR and invents none.

**A closed pool still pays what it holds (BK-earn-04).** Closing a pool (`ops.setEarnPoolStatus`, approved by a second person and appended to `bank.earn_pool_status_changes`) refuses new deposits with `bank.pool_closed`; the savings already in it keep accruing and can be taken back. The status change reads and sets neither freeze. The change runs under the pool's row lock and checks unchanged and stale revisions before it spends the approval, so two concurrent closes record one change and spend one approval.

**Unbonding moves no money until it ends.** A staking-style pool's take back sets `unbonding_started_at` and `unbonds_at` from the server's clock; from the first UTC day after that the saving earns nothing. The release (`ops.releaseUnbondedEarn`, or a take back after the end) is the ordinary `earnWithdraw` keyed `bank.earn.withdraw:<positionId>`, so a retry or a second run pays nothing twice. There is no new posting.

**Interest is paid to `available`, never added to the principal.** Compounding would mean writing a new principal figure every day, and a money column that changes daily is a running total wearing a different name.

**Rounding is always down**, in the reserve's favour. A unit invented by rounding up has to come from somewhere, and the only somewhere available is a pool funded for a smaller number — so the bug surfaces months later as a pool that cannot pay.

---

## Who may be named in a refusal

**A refusal may only describe objects the caller was already entitled to see. Where it cannot, it says `NOT_FOUND` and names nothing.** ([ADR, 2026-08-04](../../docs/adr/2026-08-04-authority-and-refusal-shape.md))

`transfers.create` and `transfers.schedule` each name **two** spaces and owner-check **one**. That is deliberate and it stays: the debit side is the side that can lose value, and paying another user is the product — a transfer moves value between two different users' spaces, and a test pins it.

What was wrong was what a **failure** said. `space-service.ts` writes its refusals for the person who owns the space (`Space "Holiday fund" is archived`, `Cannot transfer USDT into a EUR space`) and the router's mapper returned `err.message` verbatim. So transferring one atomic unit into a guessed uuid revealed whether that space existed, what its owner had **named** it, and which asset it held — for somebody else's account, without the transfer needing to succeed.

Three changes, none of which removes cross-user transfer:

| Where               | What it does now                                                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateDestination`   | Resolves the destination. Not the caller's, or absent → `NOT_FOUND`, **naming nothing**, from one construction site so the two cases cannot drift apart by a byte. Somebody else's live space in the right asset proceeds. |
| `SpaceService.find` | The lookup that does **not** throw, so "absent" and "not yours" issue the same single query. An exception is a message, and whether one was produced is itself an oracle.                                                  |
| `toTrpcError`       | Exhaustive over `BankErrorCode`, with a `never` in the default. Unmapped errors get `Bank operation failed (ref …)`; the detail goes to stderr as `bank.undisclosed_error` with that correlation id.                       |

**Owners are unaffected.** They still get `Space "Holiday fund" is archived` and `Cannot transfer USDT into a EUR space — convert first`, and tests pin both — a service so cautious the owner cannot act is a worse bug than the leak it was written for.

`assertSelf` keeps `FORBIDDEN` rather than `NOT_FOUND`, and the docblock argues why at length. Its message names nothing, so the ADR's rule is satisfied either way; the status-code half is a change to who may see what, which the ADR reserves to the owner.

---

## Database constraints as a backstop

The service checks these; the database enforces them regardless.

| Constraint                                     | What it catches                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `transfer_executions_occurrence_idx`           | **the double-fire guard** — a retried, duplicated, or DST-rewound scheduler firing twice             |
| `interest_accruals_pool_date_idx`              | a daily cron that fires twice, or a catch-up run overlapping the live schedule                       |
| `spaces_one_primary_idx`                       | two labels claiming the same balance — a UI summing spaces would double-count the user's own money   |
| `transfer_executions_settled_has_tx_ck`        | a "settled" firing with nothing in the book to point at — a phantom transfer                         |
| `transfer_executions_rejected_has_code_ck`     | "your standing order did not run" with no "because"                                                  |
| `transfer_executions_skipped_moved_nothing_ck` | a paused-over occurrence carrying a ledger tx id — resume claiming, in the book, that it moved value |
| `earn_pools_term_matches_kind_ck`              | a fixed pool with no maturity (funds locked with no release date)                                    |
| `earn_positions_principal_positive_ck`         | a negative position dragging the interest base below the honest ones                                 |
| `earn_pools_apr_sane_ck`                       | a bps/percent unit mix-up draining a pool reserve in a day                                           |
| `scheduled_transfers_amount_positive_ck`       | an instruction to pull money the other way that nobody authorised                                    |
| `interest_accruals_consistent_ck`              | money paid with nobody to pay it to, or recipients paid nothing                                      |

---

## What the schema stores — and deliberately does not

| Table                                                           | Stores                                                              | Deliberately absent                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| `spaces`                                                        | name, kind, savings **goal**, self-imposed lock                     | any balance                                        |
| `scheduled_transfers`                                           | the **instruction**, immutable after insert                         | a counter of firings                               |
| `transfer_executions`                                           | one **record** per (schedule, occurrence)                           | a running sum of transferred value                 |
| `earn_pools`                                                    | terms — APR, term length, minimum deposit                           | `total_deposited`, `capacity_used`                 |
| `earn_positions`                                                | the deposit **record**; principal never changes                     | accrued interest, current value                    |
| `interest_accruals`                                             | one **record** per (pool, day)                                      | a lifetime interest total                          |
| loan product / loan / collateral / accrual / margin-call tables | terms, status, write-once movements, call record                    | an `outstanding` balance column — derived at read  |
| card / authorisation / settlement tables                        | programme row, every decision (approve **and** decline), claim rows | a real PAN, a live issuer id that is not simulated |
| ramp on/off tables                                              | credits and holds with `simulated` always set                       | a fiat rail id that pretends to settle             |

Editing a standing order cancels it and writes a new one, so the history of what a user actually authorised survives.

---

## Kill-switches

| Variable                                        | Guards                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SCHEDULED_TRANSFERS_ENABLED`                   | A bad deploy mis-computing occurrence indices would fire every schedule in the book, and the ledger is append-only |
| `INTEREST_ACCRUAL_ENABLED`                      | A reserve drained by a runaway job cannot be un-paid without asking users to return money                          |
| `LOAN_ACCRUAL_ENABLED`                          | Loan interest capitalisation is its own flag — stopping earn payout must not stop charging borrowers               |
| `LOAN_RISK_SWEEP_ENABLED`                       | Defaults **off**. Sells people's collateral; a fresh deploy must not liquidate until a human has checked marks     |
| `AUTO_INVEST_ENABLED`                           | Stops threshold/DCA runs **and** the card-capture round-up hook — same code `bank.auto_invest_disabled`            |
| `BANK_LOANS_ENABLED`                            | Module kill for loans (`FLAG_REGISTRY` bank.loans) — OFF refuses new opens                                         |
| `BANK_CARDS_ENABLED`                            | Module kill for cards ledger half (`bank.cards`) — OFF refuses issue and authorise                                 |
| `TRANSFER_BATCH_SIZE` / `LOAN_SWEEP_BATCH_SIZE` | Bounds the blast radius of a single bad pass                                                                       |
| `BANK_SCHEDULE_EDIT_CUTOFF_MINUTES`             | Owner value: how close to its next run an active standing order may still be edited. Blank refuses every edit      |
| `BANK_RECOVERY_JOBS_INTERVAL_MS`                | Recovery timer. Default 60000. Blank disables it and logs a startup warning                                        |
| `BANK_RECOVERY_JOBS_BATCH_LIMIT`                | Recovery pass cap. Default 50. Blank disables the timer the same way                                               |

Each env job flag gates **both** the HTTP `/internal/jobs/*` endpoint **and** the matching `ops.*` tRPC mutation (same 503 / named code). tRPC is not a back door past an emergency stop.

| Registry flag (`FLAG_REGISTRY`)           | What it is today                                                                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bank.loans`                              | **Enforced** — `service-env` → `BANK_LOANS_ENABLED` on svc-bank. OFF refuses **new loan opens** (`bank.loans_disabled`). Accrual / risk-sweep stay on their own job flags. Restart required.  |
| `bank.cards`                              | **Enforced** — `service-env` → `BANK_CARDS_ENABLED` on svc-bank. OFF refuses **issue and authorise** (`bank.cards_disabled`). Issuer setting still names the programme when the module is on. |
| `bank.sovereignCard`, `bank.cardWaitlist` | **Named only** — `NOT_ENFORCED`. Sovereign card is §13 / Shehzad; waitlist has no money path.                                                                                                 |

Standing orders, accrual, the risk sweep and auto-invest stay external endpoints, not a `setInterval`, so an operator can pause, inspect and re-run them. Duplicate firing is safe — that is the point of the idempotency work — but "safe when it happens" is not a reason to make it happen on every deploy.

The three recovery jobs also run on a timer. A lost ledger acknowledgement leaves a loan open, a repayment, or an earn deposit `pending`, and no caller was hitting the endpoints, so the row stayed pending. `BANK_RECOVERY_JOBS_INTERVAL_MS` defaults to 60000 (the trade hold-unknown sweep). `BANK_RECOVERY_JOBS_BATCH_LIMIT` defaults to 50 (that sweep's batch). A blank value disables the timer and logs a startup warning. One session advisory lock (`bank.recovery.jobs`) so two replicas do not run the pass together. A tick that throws backs off; the next tick still runs. The job functions are unchanged: unknown stays unknown until the ledger answers.

---

## Running it

```bash
docker compose up -d
pnpm --filter @intafaced/svc-bank db:migrate
pnpm --filter @intafaced/svc-bank test
```

## Tests

**~300+ cases across eight files**, including loans, cards, and ramps suites — not a frozen exact count (it moves with craft PRs). Layout on tip (approximate, re-count with `rg -c '^\s*(it|test)\(' services/svc-bank --glob '*.test.ts'`):

| File                                   | Covers                                            |
| -------------------------------------- | ------------------------------------------------- |
| `bank-service.test.ts`                 | spaces, transfers (incl. pause/resume), earn, ops |
| `loans/loans.test.ts`                  | open / repay / LTV / liquidation ladder           |
| `loans/margin-call-publisher.test.ts`  | `intafaced.bank.margin_call.created` publish      |
| `cards/cards.test.ts`                  | issue / auth / capture / reverse / cashback / JIT |
| `cards/cards.reachable.test.ts`        | composition-root reachability + scopes            |
| `cards/sovereign-card-product.test.ts` | D26-P1-B3 mounted JIT refuse-invent / freeze seal |
| `ramps/ramps.test.ts`                  | crypto ledger half + fiat refuse                  |
| `ramps/ramps.reachable.test.ts`        | composition-root reachability                     |
| `router.mount.test.ts`                 | mount boundary / unsigned principal               |

All against real Postgres with `MemoryLedger` as the ledger — the reference implementation the conformance suite proves equivalent to svc-ledger's Postgres engine (§4.4). Each file takes its **own database** rather than its own schema (#429), so concurrent worktrees do not truncate each other. The suite skips itself cleanly when Postgres is unavailable.

Failure branches covered (sample, not exhaustive): insufficient funds on a one-off transfer and on a standing order, a cross-asset transfer, a debit from a user-locked space, pause/resume skip rows that move nothing, a deposit larger than the user holds, a deposit below the pool minimum, an early withdrawal from a fixed term, a double withdrawal, concurrent withdrawals and job runs, a re-run of a rejected occurrence, an accrual from an unfunded pool (and its recovery once funded), a second accrual on the same day, a position opened after the accrual moment, a schedule past its end date, a cancelled schedule, a native-asset earn pool, a claim left stranded by a crashed run, plus loans / cards / ramps suites for their own refusal and recovery paths.

## Cards: what is built, and what is a contract

`bank.cards` splits in two, and the halves fail for unrelated reasons. **They are split, not resolved.**

| Half          | Missing in the WORLD                                     | Verdict                                        |
| ------------- | -------------------------------------------------------- | ---------------------------------------------- |
| **Ledger**    | Nothing. Auth decision, balance check, decline, cashback | **Built.** `src/cards/`, 36 tests              |
| **Live rail** | A card-scheme sponsor and an issuing BIN                 | **§13 forever.** Lands on `socket.live-issuer` |

`CardIssuerAdapter` (`src/cards/issuer.ts`) is the seam. Everything above it is finished; everything below it is a licence and a contract that no amount of engineering time produces.

**No new ledger recipe was needed, and that is the design.** A card spend **is a withdrawal**, so the four postings already existed:

| Step                   | Recipe            | Effect                                           |
| ---------------------- | ----------------- | ------------------------------------------------ |
| authorisation approved | `withdrawHold`    | available → a hold account **per authorisation** |
| capture (clearing)     | `withdrawSettle`  | hold → `railBoundary('card-sim', asset)`         |
| the unspent remainder  | `withdrawReverse` | hold → available, in the same pass               |
| cashback               | `rewardPay`       | `rewardsEngine(asset)` → available               |

A `cardSpend` recipe would have been `withdrawSettle` with a different string in it — a second way to spell one movement, which is how two subsystems come to disagree about what happened.

### `card-sim` is a simulator. What it is **not**

- **NOT a card.** Nothing here can be presented at a terminal, added to a wallet, or used online. `panTail` is four digits derived from a uuid, and there is no column a card number could be stored in.
- **NOT a connection** to a card scheme, issuer, processor or bank. It makes no network call and has no credentials to make one with.
- **NOT a settlement rail.** `railBoundary('card-sim', asset)` records that value left **our** book; nothing is on the other side of it.
- **NOT a decision engine.** No fraud scoring, no velocity check, no 3-D Secure, no MCC policy. There are exactly four decline reasons and each is a fact somebody can check afterwards.
- **NOT refunds, disputes, chargebacks, or incremental authorisations.** A refund is `recipes.deposit` over the same rail and is deliberately unbuilt: it brings a product question — whether cashback on the original capture is clawed back — that inventing an answer to would make the module look finished while paying for returned purchases.

`simulated: true` is on the card row, on the port, and on every router output. A deployment with **no** issuer configured refuses every card procedure with `bank.no_card_issuer` rather than falling back to the simulator — the same posture as the loan price source, and for the same reason: the dangerous default is the plausible one.

### Turning the card surface on, and what that does not mean

One variable, two values, and `none` is the default.

```bash
BANK_CARD_ISSUER=none      # this deployment has NO card programme  (default)
BANK_CARD_ISSUER=card-sim  # the SIMULATOR — see immediately above
```

`/ready` reports which one is in force, so nobody has to trust an env file:

```jsonc
// BANK_CARD_ISSUER=none
"cardProgramme": { "id": "none", "simulated": true, "displayName": "No card programme" }
// BANK_CARD_ISSUER=card-sim
"cardProgramme": { "id": "card-sim", "simulated": true, "displayName": "Simulated card (no card programme)" }
```

`simulated` is `true` in **both**, and there is no value of this variable that makes it false. That is not an oversight — a live rail cannot be selected here at all, because it is `socket.live-issuer`: a card-scheme sponsor and an issuing BIN, which is a licence and a contract. The same fact appears in four places on purpose (`/ready`, the boot log line, `cards.programme`, and `simulated` on every card), so an operator, a user and an auditor each meet it without having to go looking.

What `card-sim` **does** get you is the ledger half, end to end, over real postings: issue a card, authorise against a real balance, be declined by name when the money is not there, capture, and get the remainder back. Simulated cards refuse cashback with `bank.rewards_issuer_unset`, even when the rewards pot is funded, and create no cashback row. What it does not get you is a card.

`cards.reachable.test.ts` is the suite that holds this: it enters through `createBankRouter(...).createCaller` over a context built by the real `createEdgeContext` from a **signed** principal — the composition root and the router, never a `CardService` — so if the wiring, the mounting or the scopes regress, it fails rather than the module quietly going unreachable again.

**Cashback has a named source.** It is paid from `rewardsEngine(asset)`, funded by `ops.fundCashbackPot` sweeping `houseFees('bank', asset)` — fees the platform really charged. An empty pot refuses by name (`bank.cashback_pot_unfunded`) on a row, and the capture still stands: undoing a purchase the merchant already has, because a marketing promise could not be kept, would be the worse failure.

A new reward also requires a connected, non-simulated issuer matching the card.
Recovery keeps an unknown reward pending and retries its original idempotency
key. Without that issuer, recovery can reconcile a transaction already present
in the ledger; it cannot post a new reward for a simulated card. Migration 0024
continues to refuse new or updated cards claiming `simulated: false`; preserved
legacy rows are not rewritten.

---

## Sockets (§13)

- **`socket.live-issuer`** — a card programme needs a **card-scheme sponsor and an issuing BIN**. That is a licence and a commercial relationship, not code: no amount of engineering time produces one, which is precisely the §13 test. `CardIssuerAdapter` is written against the shape a live issuer would implement, and the only implementation in the tree is `cardSim()`, which says on every surface that it is a simulator. Pointing working code at real money is additionally Class X.
- **`socket.psp-partners`** — fiat on/off ramp needs a **bank/PSP partner and money-transmission permission**. Same §13 test. Kind fiat refuses `bank.fiat_ramp_socket` before any row or ledger post. A live injected pay rail is not a stored fiat row and is not a ledger post from this service. Commercial partner + Class X remain the socket.
- **`ledger.history`** — spend analytics needs a transaction-history read that svc-ledger does not expose yet. Declaring it is a `packages/contracts` + svc-ledger PR that must land first (§1). `createLedgerHistory()` is written against the shape and **fails loudly** rather than returning an empty answer: a spend view that silently reports zero is worse than one that is unavailable, because the user cannot tell "you spent nothing" from "we could not ask".
- **Chunked interest keys** — one accrual is one ledger transaction per (pool, day). When a pool outgrows a single transaction the key gains a deterministic chunk index, `bank.interest:<poolId>:<date>:<chunk>`, which keeps the same property per chunk. The shape was chosen so that change is additive.

## What is still Nitro-only (not agent craft)

Code for loans, cards (ledger half), ramps (crypto half), and standing-order pause/resume is **on main**. What is not agent-finishable:

| Residual                                    | Why it is not craft                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| **Fiat partner** (`socket.psp-partners`)    | Bank/PSP + money-transmission permission — commercial + regulatory          |
| **Live card issuer** (`socket.live-issuer`) | Card-scheme sponsor + issuing BIN — licence; Class X to point at real money |

`bank.sovereign-card` **custodial JIT half** is on main (#1174) and sealed at the mounted door (D26-P1-B3 / `sovereign-card-product.test.ts`): refuse invent FX (`bank.mark_missing`), freeze rate at auth, ledger-only funding asset. The **on-chain / smart-account funding half** remains Shehzad (`protocol.smart-accounts`); the live card rail remains `socket.live-issuer`.

## Ramps: crypto ledger half vs fiat socket

| Half       | Missing in the WORLD                                    | Verdict                                                                                              |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Crypto** | Nothing for the ledger half. Chain confirm/send is pay. | **Built** as ledger sandbox (`bank-crypto-ledger`)                                                   |
| **Fiat**   | A bank/PSP partner and money-transmission permission    | **Refused.** Kind fiat refuses `bank.fiat_ramp_socket` before any row or ledger post. Partner is §13 |

`BANK_RAMP_MODE=crypto-ledger` books crypto deposits and withdrawals against rail `bank-crypto-ledger` — deliberately distinct from svc-pay's `crypto-native` boundary so an operator credit here cannot desync pay's chain reconciliation. `simulated: true` is never omitted. Kind fiat refuses `bank.fiat_ramp_socket` before any row or ledger post. Live broadcast and inbound confirmation stay in svc-pay; Class X is pointing working code at real money.

## Service keys (S2S v3)

With `S2S_AUTH_MODE`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` set, every call to svc-ledger (posts, reads and history) is signed with svc-bank's own key, and the ledger names the caller from that key. `dual` also sends the shared secret; `keypair` sends the key signature only. Unset, the ledger calls are signed with the shared secret as before. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.

## Service keys: inbound doors

The internal job doors, the closure check, svc-agents' business team read and `/trpc` name the caller from its own service key when `S2S_AUTH_MODE`, `S2S_KEYRING` and the signing pair are set: `dual` accepts the key and the shared secret, `keypair` the key only. Unset, the shared secret works exactly as before. A key-signed call that fails is refused and never retried against the shared secret. The job doors keep binding the retained request bytes. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.

## Service keys: outgoing calls

The calls to svc-identity (affiliate accrue and payout, recipient status, handle lookup, business directory, recovery estates and claim checks) and to svc-trade (auto-invest convert quote and execute) are signed with svc-bank's own key when `S2S_AUTH_MODE`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` are set (`S2S_KEYRING` lets the doors verify callers); `dual` also sends the shared secret, `keypair` the key only. Unset, they are signed with the shared secret exactly as before. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.
