import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { amount, bps, createdAt, tstz, updatedAt } from '@intafaced/db';

/**
 * svc-bank — MULTI-CURRENCY ACCOUNTS OVER THE LEDGER (§8.1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT IN THIS FILE, AND WILL NEVER BE: A BALANCE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * §8.1: "Multi-currency account UX over existing ledger accounts (no new
 * balance system — views + rails)." Doctrine §0.6: "No module holds its own
 * balance."
 *
 * Every table here stores one of exactly three things:
 *
 *   1. A NAME AND A POLICY — what the user calls a pot of money, and the rules
 *      they attached to it. `spaces` is a label over a ledger account; it holds
 *      no value and cannot hold value.
 *   2. AN INSTRUCTION — "move 200 USDT on the 1st of every month". Amounts on
 *      instructions are what the user asked for, not what anything currently
 *      holds. A standing order's amount changes only by a customer edit, which
 *      writes the old value to `schedule_revisions` and bumps `revision`.
 *   3. A RECORD OF SOMETHING THAT ALREADY HAPPENED — one row per (schedule,
 *      occurrence) or per (pool, day), written once, never updated in place with
 *      a new figure. These exist to make a job idempotent and auditable, not to
 *      answer "how much".
 *
 * "How much" is always `ledger.balance(...)`. There is exactly one answer, and
 * it is not in this schema. `bank-service.test.ts` introspects
 * `information_schema.columns` and fails the build on any column that looks
 * like a running total, so this comment is enforced rather than aspirational.
 *
 * The one column that is money-shaped and mutable — there is none — would need
 * the narrow exception svc-token's README describes (a cache with a documented
 * reconciliation job). svc-bank does not take it. A cache of a number the
 * ledger already returns in one indexed read buys nothing and costs a second
 * source of truth.
 */
export const bank = pgSchema('bank');

/**
 * A user's PRIMARY space in an asset is their `userAvailable` ledger account
 * itself — the main balance, given a name. Every other space is a `subaccount`
 * available account, which is an account kind the ledger already has (§4.2
 * `owner_type` includes `subaccount`); svc-bank invents nothing.
 *
 * The distinction is load-bearing: it is why "the primary space's balance equals
 * the user's ledger balance" is true by construction rather than by a job.
 */
export const spaceKindEnum = bank.enum('space_kind', ['primary', 'named']);

/** §8.1 rails. Cadence is closed because the occurrence index must be derivable. */
export const transferCadenceEnum = bank.enum('transfer_cadence', ['daily', 'weekly', 'monthly', 'once']);

export const scheduleStatusEnum = bank.enum('schedule_status', ['active', 'paused', 'cancelled', 'completed']);

/**
 * `pending` is a claim, not a state anyone should stay in: the job inserts the
 * row before it posts to the ledger, so a crash between the two leaves a
 * `pending` row that the next run re-drives (the ledger post is idempotent, so
 * re-driving either finds the original transaction or makes it).
 *
 * `skipped` is the opposite of `pending`: nothing was ever attempted, because
 * the standing order was paused when this occurrence came due. It is a ROW
 * rather than an absence because `MAX(occurrence)` over this table is what
 * `planDue` reads as `lastFired` — an occurrence with no row is one the next
 * pass will fire, so without this value resuming a three-month pause would post
 * three months of transfers at once.
 *
 * `rejected` is deliberately not reused for it. Rejected means the ledger
 * refused a real attempt, which is the answer to "why is my space empty".
 * Skipped means nobody asked, which is the answer to "why did nothing happen
 * while I was away". Collapsing them leaves both unanswerable.
 */
export const executionStatusEnum = bank.enum('execution_status', ['pending', 'settled', 'rejected', 'skipped']);

export const poolKindEnum = bank.enum('pool_kind', ['flexible', 'fixed']);
export const poolStatusEnum = bank.enum('pool_status', ['open', 'closed']);
export const positionStatusEnum = bank.enum('position_status', ['pending', 'active', 'closed']);

/**
 * A SPACE — a name and a policy over a ledger account (§8.1).
 *
 * Not a wallet. Not a balance. The row tells you what the user calls this pot
 * and what rules they set on it; `ledger.balance(accountFor(space))` tells you
 * what is in it, and is the only thing that ever does.
 */
export const spaces = bank.table(
  'spaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    /** Which asset this space is denominated in. Multi-currency = many rows. */
    assetId: text('asset_id').notNull(),
    kind: spaceKindEnum('kind').notNull().default('named'),
    /** The user's label. The entire product surface of this table. */
    name: text('name').notNull(),
    /**
     * A savings TARGET the user set — "I want 5000 USDT in here". It is an
     * aspiration, never a holding: it is written when the user sets it and read
     * only to render a progress bar against the LEDGER balance. Nothing in this
     * service ever adds to it.
     */
    goalTarget: amount('goal_target'),
    /**
     * A self-imposed lock date. Policy, enforced by this service on transfers
     * OUT — the ledger has no opinion about it, which is correct: a user
     * locking themselves out of their own money is a product rule, not a
     * property of the book.
     */
    lockedUntil: tstz('locked_until'),
    /**
     * An early unlock the owner confirmed (BK-pots-02): when they asked, and when the lock ends instead of `lockedUntil`
     * (never later). Set together or both null (`spaces_early_unlock_ck`); a new lock date clears them.
     */
    unlockRequestedAt: tstz('unlock_requested_at'),
    unlocksAt: tstz('unlocks_at'),
    archivedAt: tstz('archived_at'),
    /**
     * The customer removed this currency from their account (BK-acct-01). Primary spaces only, set only while the
     * asset holds nothing; a label, never a balance.
     */
    removedAt: tstz('removed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** The list-my-spaces read path. */
    index('spaces_user_asset_idx').on(t.userId, t.assetId),
    /** One space name per user per asset — the label is how a human refers to it. */
    uniqueIndex('spaces_user_asset_name_idx').on(t.userId, t.assetId, t.name),
  ],
);

/**
 * A STANDING ORDER (§8.1 rails).
 *
 * `amount` here is the instruction — "move this much". An edit changes it (and the
 * end date) one revision at a time; what it said before each edit is kept in
 * `schedule_revisions`, so the history of what a user authorised survives. The
 * amount each run posted is on its execution row.
 */
export const scheduledTransfers = bank.table(
  'scheduled_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    assetId: text('asset_id').notNull(),
    fromSpaceId: uuid('from_space_id')
      .notNull()
      .references(() => spaces.id),
    toSpaceId: uuid('to_space_id')
      .notNull()
      .references(() => spaces.id),
    amount: amount('amount').notNull(),
    cadence: transferCadenceEnum('cadence').notNull(),
    /**
     * The anchor. Occurrence N is N periods after this instant, which is what
     * makes the idempotency key `bank.transfer.<space>:<id>:<occurrence>` derivable
     * from the schedule alone rather than from a counter that can be lost or
     * double-incremented.
     */
    startsAt: tstz('starts_at').notNull(),
    /** NULL = runs until cancelled. */
    endsAt: tstz('ends_at'),
    /** Scheduling index only — the truth of "did occurrence N fire" is the execution row. */
    nextRunAt: tstz('next_run_at').notNull(),
    status: scheduleStatusEnum('status').notNull().default('active'),
    /** Starts at 1; an edit names the revision it read and adds one. */
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** The job's query: what is due. */
    index('scheduled_transfers_due_idx').on(t.status, t.nextRunAt),
    index('scheduled_transfers_user_idx').on(t.userId),
  ],
);

/**
 * ONE FIRING OF ONE STANDING ORDER — the idempotency ledger of the scheduler.
 *
 * `unique(schedule_id, occurrence)` is what makes "a job that runs twice
 * transfers once" a property of the database rather than a hope about timers.
 * The ledger's own idempotency key is the second line of defence; this is the
 * first, and it also gives the user a reason when a transfer did not happen.
 *
 * `amount` records what was actually moved on this occurrence. It is written
 * once, alongside the ledger transaction id, and never revised.
 */
export const transferExecutions = bank.table(
  'transfer_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => scheduledTransfers.id),
    /** Periods since `starts_at`. Deterministic, so the key is reproducible. */
    occurrence: integer('occurrence').notNull(),
    amount: amount('amount').notNull(),
    status: executionStatusEnum('status').notNull().default('pending'),
    /** svc-ledger's transaction id — the join back to the book. */
    ledgerTxId: text('ledger_tx_id'),
    /** Why a firing was rejected, e.g. 'ledger.insufficient_funds'. */
    rejectionCode: text('rejection_code'),
    attemptedAt: tstz('attempted_at').notNull().defaultNow(),
    settledAt: tstz('settled_at'),
  },
  (t) => [
    /** THE double-fire guard. See the migration's comment. */
    uniqueIndex('transfer_executions_occurrence_idx').on(t.scheduleId, t.occurrence),
    index('transfer_executions_status_idx').on(t.status),
  ],
);

/** What a standing order said before an edit replaced it (one row per replaced revision; migration 20261024061755_schedule_revision). */
export const scheduleRevisions = bank.table(
  'schedule_revisions',
  {
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => scheduledTransfers.id),
    revision: integer('revision').notNull(),
    amount: amount('amount').notNull(),
    endsAt: tstz('ends_at'),
    /** Who made the edit that replaced this revision. */
    replacedBy: text('replaced_by').notNull(),
    replacedAt: tstz('replaced_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.scheduleId, t.revision] })],
);

/**
 * AN EARN POOL (§8.1) — flexible or fixed-term, per asset.
 *
 * Deliberately absent: `total_deposited`, `subscribed`, `capacity_used`, or any
 * other figure that would drift. A pool's size is the sum of the ledger `stake`
 * accounts of its open positions, and `earnService.poolSize()` computes it that
 * way every time it is asked.
 */
export const earnPools = bank.table(
  'earn_pools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: text('asset_id').notNull(),
    kind: poolKindEnum('kind').notNull(),
    name: text('name').notNull(),
    /** Advertised annual rate. Policy — the accrual job reads it, nothing writes it back. */
    aprBps: bps('apr_bps').notNull(),
    /** NULL for flexible pools; the lock length for fixed ones. */
    termDays: integer('term_days'),
    /** Policy floor on a single deposit. Null is a blank limit; an omitted floor is not zero. */
    minDeposit: amount('min_deposit'),
    status: poolStatusEnum('status').notNull().default('open'),
    /** Staking-style (BK-earn-04): days a saving taken back unbonds before it is released. Null: no unbonding. Flexible only. */
    unbondingDays: integer('unbonding_days'),
    /** How many approved status changes the pool has had (`earn_pool_status_changes`). */
    statusRevision: integer('status_revision').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('earn_pools_asset_status_idx').on(t.assetId, t.status)],
);

/**
 * ONE USER'S POSITION IN ONE POOL.
 *
 * `principal` is the amount deposited at open, recorded once — the same shape
 * and the same reason as svc-token's `stakes.amount`. Interest never touches
 * it: yield is paid to the user's available balance, so there is no compounding
 * write that could turn this column into a running total by accident.
 *
 * The value itself sits in `userStake(userId, assetId)` in the ledger, which is
 * shared with svc-token's native staking — which is exactly why svc-bank
 * refuses the native asset in earn pools (see `earn-service.ts`).
 */
export const earnPositions = bank.table(
  'earn_positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => earnPools.id),
    userId: text('user_id').notNull(),
    assetId: text('asset_id').notNull(),
    principal: amount('principal').notNull(),
    openedAt: tstz('opened_at').notNull().defaultNow(),
    /** NULL for flexible. Withdrawal before this is refused on fixed pools. */
    maturesAt: tstz('matures_at'),
    /** Claim before the ledger post. An omitted status is not interest-eligible. */
    status: positionStatusEnum('status').notNull().default('pending'),
    closedAt: tstz('closed_at'),
    /** The saver's choice to start a new term when a fixed-term saving ends (BK-earn-03). Fixed-term only. */
    autoRenew: boolean('auto_renew').notNull().default(false),
    /** When the saver asked a staking-style saving to unbond (BK-earn-04). Written once. */
    unbondingStartedAt: tstz('unbonding_started_at'),
    /** When that unbonding ends and the saving can be released. Set with `unbondingStartedAt`. */
    unbondsAt: tstz('unbonds_at'),
    createdAt: createdAt(),
  },
  (t) => [
    /** The accrual job sweeps a pool's open positions. */
    index('earn_positions_pool_status_idx').on(t.poolId, t.status),
    index('earn_positions_user_status_idx').on(t.userId, t.status),
    /** The unbonding release job's sweep (BK-earn-04); unbonding CHECKs live in the migration. */
    index('earn_positions_unbonds_at_idx')
      .on(t.unbondsAt)
      .where(sql`${t.status} = 'active' AND ${t.unbondsAt} IS NOT NULL`),
  ],
);

/**
 * ONE DAY OF INTEREST FOR ONE POOL — written once, per (pool, date).
 *
 * The unique index is the daily double-fire guard, mirroring
 * `transfer_executions`. `paid_amount` is the audit record of that single day,
 * not a cumulative figure: summing this table gives lifetime interest, and that
 * sum must equal what the ledger paid out of the pool reserve. Two answers,
 * comparable — which is the whole point of not keeping a total.
 */
export const interestAccruals = bank.table(
  'interest_accruals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => earnPools.id),
    /** The accrual day. `date`, not a timestamp — a day is the unit of truth here. */
    accrualDate: date('accrual_date').notNull(),
    /** The rate actually applied, snapshotted so a later APR change cannot rewrite history. */
    rateBps: bps('rate_bps').notNull(),
    paidAmount: amount('paid_amount').notNull(),
    recipients: integer('recipients').notNull().default(0),
    ledgerTxId: text('ledger_tx_id'),
    /**
     * The payout list planned for the day, committed with the claim before the
     * ledger post: `[{ userId, amount }]`, amounts as decimal strings. Null for
     * a row with nothing to resume: written before 0032, or an empty day.
     */
    plannedPayouts: jsonb('planned_payouts').$type<ReadonlyArray<{ userId: string; amount: string }>>(),
    createdAt: createdAt(),
  },
  (t) => [
    /** ONE ACCRUAL PER POOL PER DAY, forever. */
    uniqueIndex('interest_accruals_pool_date_idx').on(t.poolId, t.accrualDate),
    index('interest_accruals_date_idx').on(t.accrualDate),
    /** One person's paid days by containment on the stored plan (earn.interestHistory). */
    index('interest_accruals_planned_payouts_idx').using('gin', sql`${t.plannedPayouts} jsonb_path_ops`),
  ],
);

/**
 * EVERY RATE A POOL HAS PUBLISHED (BK-earn-05), append-only (a trigger refuses UPDATE and DELETE).
 *
 * Opening a pool records its first rate; an approved change records the next, in the same transaction as the pool's
 * `apr_bps`. A pool opened before this table has no record until its first change, and none is invented for it.
 */
export const earnRateChanges = bank.table(
  'earn_rate_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => earnPools.id),
    rateBps: integer('rate_bps').notNull(),
    effectiveAt: tstz('effective_at').notNull(),
    reason: text('reason'),
    /** The identity approval a change consumed; null for the opening record. */
    approvalId: text('approval_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('earn_rate_changes_pool_effective_uq').on(t.poolId, t.effectiveAt),
    uniqueIndex('earn_rate_changes_approval_uq')
      .on(t.approvalId)
      .where(sql`${t.approvalId} IS NOT NULL`),
  ],
);

/**
 * ONE RENEWED TERM OF A FIXED-TERM SAVING (BK-earn-03) — append-only, one row per (position, term).
 *
 * The key is the relock's business key: a renewal job that runs twice renews once. Nothing posts: the principal
 * stays in the saving's stake pot and only the maturity moves.
 */
export const earnRenewals = bank.table(
  'earn_renewals',
  {
    positionId: uuid('position_id')
      .notNull()
      .references(() => earnPositions.id),
    /** 1 for the first renewal, counting up. */
    term: integer('term').notNull(),
    previousMaturesAt: tstz('previous_matures_at').notNull(),
    maturesAt: tstz('matures_at').notNull(),
    principal: amount('principal').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.positionId, t.term] })],
);

/**
 * ONE APPROVED STATUS CHANGE OF AN EARN POOL (BK-earn-04) — append-only, one row per (pool, revision).
 *
 * The key is the change's business key `pool-status:<poolId>:<revision>`: two approvals for the same revision change
 * the pool once. A status is a pool-level pause on new savings; it is not an account or posting freeze.
 */
export const earnPoolStatusChanges = bank.table(
  'earn_pool_status_changes',
  {
    poolId: uuid('pool_id')
      .notNull()
      .references(() => earnPools.id),
    revision: integer('revision').notNull(),
    status: poolStatusEnum('status').notNull(),
    previousStatus: poolStatusEnum('previous_status').notNull(),
    reason: text('reason').notNull(),
    approvalId: text('approval_id').notNull(),
    /** The person who proposed the change and the second person who approved it. */
    requestedBy: text('requested_by').notNull(),
    approvedBy: text('approved_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.poolId, t.revision] })],
);

// ═════════════════════════════════════════════════════════════════════════════
// LOANS (§8.1) — collateral lock, LTV marking, margin call, liquidation, accrual
// ═════════════════════════════════════════════════════════════════════════════
//
// THERE IS NO `outstanding` COLUMN. A loan's debt is the number that decides
// whether someone's collateral is sold, and the obvious schema gives `loans` an
// `outstanding_principal` that a nightly job adds to. The guard in
// `bank-service.test.ts` fails the build on that column by name, and it is right
// to: a mutable money column written by a job is a running total, and a half-run
// accrual or a repayment racing it leaves a figure nothing can contradict — while
// every LTV afterwards is computed from it.
//
// So the debt is EVENT-SOURCED from the write-once tables below, and
// `loan-service.ts` derives it in bigint on every read:
//
//   outstanding = loans.principal
//               + Σ loanInterestAccruals.interestAmount
//               − Σ loanRepayments.(principalAmount + interestAmount)
//               − Σ loanLiquidations.(principalRepaid + interestRepaid)
//
// Not a VIEW either: a view's columns appear in `information_schema.columns`, so
// exposing this sum as one would either trip the guard or have to be named to
// dodge it — and dodging a guard that is telling the truth is worse than the
// column would have been. See 0002_bank_loans.sql for the long form.
//
// Basis-point columns here are `integer`, not `bps()`/numeric(8,0) as the earn
// tables use. Deliberate: a basis point IS an integer, and numeric(8,0)
// round-trips as a string that every risk call site would then have to `Number()`
// — exactly the kind of casual parse this module cannot afford. Neither shape is
// money-typed, so the schema guard is indifferent between them.

export const loanStatusEnum = bank.enum('loan_status', [
  /**
   * Collateral is locked; principal has NOT been released.
   *
   * The crash-safe state, and the reason lock and draw are separate
   * transactions. A process that dies here strands nothing: the collateral is in
   * the borrower's own purposed ledger account and the reserve has not moved, so
   * re-driving completes the loan and abandoning it releases the collateral.
   * Draw-then-lock has a window in which the borrower holds principal against no
   * collateral, and no retry closes it, because they can spend inside it.
   */
  'pending',
  'active',
  /** LTV crossed the margin-call threshold; the grace clock is running. */
  'margin_call',
  'liquidating',
  'repaid',
  'liquidated',
]);

export const collateralDirectionEnum = bank.enum('collateral_direction', ['lock', 'release']);

/** Same three states as `execution_status`, for the same crash-safety reason. */
export const loanEventStatusEnum = bank.enum('loan_event_status', ['pending', 'settled', 'rejected']);

/**
 * A LOAN PRODUCT — policy, and nothing but policy.
 *
 * Every money column is a limit; no money path writes any of them. The threshold
 * ordering is a database CHECK rather than a comment, because a product whose
 * thresholds are incoherent produces a loan that can be liquidated before it is
 * ever called, and that is not discoverable by reading a row.
 */
export const loanProducts = bank.table(
  'loan_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    debtAssetId: text('debt_asset_id').notNull(),
    collateralAssetId: text('collateral_asset_id').notNull(),
    /** The asset LTV is measured in. Both marks are taken against it. */
    quoteAssetId: text('quote_asset_id').notNull(),
    aprBps: integer('apr_bps').notNull(),
    /** The most a borrower may draw at open. */
    maxLtvBps: integer('max_ltv_bps').notNull(),
    marginCallLtvBps: integer('margin_call_ltv_bps').notNull(),
    liquidationLtvBps: integer('liquidation_ltv_bps').notNull(),
    /**
     * Grace is waived above this — the one place the
     * margin-call-before-liquidation ordering is knowingly broken. It is a NUMBER
     * in policy rather than a branch in code, so it is visible per product and
     * shows up in a diff when someone moves it. `risk.ts` sets out both readings
     * of the trade-off and why this one was taken.
     */
    insolvencyLtvBps: integer('insolvency_ltv_bps').notNull(),
    /** Where a liquidation STOPS. Must be below margin-call — see the CHECK. */
    targetLtvBps: integer('target_ltv_bps').notNull(),
    penaltyBps: integer('penalty_bps').notNull(),
    /** Ceiling on one rung of the ladder, as a fraction of remaining collateral. */
    maxTrancheBps: integer('max_tranche_bps').notNull(),
    graceSeconds: integer('grace_seconds').notNull(),
    /** Policy floor on a single draw. Null is a blank limit; an omitted floor is not zero. */
    minPrincipal: amount('min_principal'),
    status: text('status').notNull().default('open'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('loan_products_assets_idx').on(t.debtAssetId, t.collateralAssetId, t.status)],
);

/**
 * ONE LOAN.
 *
 * `principal` is what was DRAWN at open, recorded once and never revised — the
 * same shape and reason as `earn_positions.principal`. Interest never touches it;
 * the day's charge is a row in `loanInterestAccruals`, which is what keeps this
 * column from quietly becoming the running total the schema forbids.
 *
 * Terms are snapshotted from the product at open, so a later product edit cannot
 * rewrite the terms of a loan somebody already agreed to.
 */
export const loans = bank.table(
  'loans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => loanProducts.id),
    userId: text('user_id').notNull(),
    debtAssetId: text('debt_asset_id').notNull(),
    collateralAssetId: text('collateral_asset_id').notNull(),
    quoteAssetId: text('quote_asset_id').notNull(),
    aprBps: integer('apr_bps').notNull(),
    principal: amount('principal').notNull(),
    /**
     * Collateral pledged at open — write-once term for id-reuse compares.
     * Not a live balance (see `loan_collateral_events` + ledger).
     */
    openingCollateral: amount('opening_collateral'),
    /**
     * LTV bands agreed at open, copied from the product once. A later edit of
     * the product does not re-band this loan. Null only on a row the migration
     * could not fill; the book counts that loan as unpriced.
     */
    marginCallLtvBps: integer('margin_call_ltv_bps'),
    liquidationLtvBps: integer('liquidation_ltv_bps'),
    status: loanStatusEnum('status').notNull().default('pending'),
    /** NULL means the principal has not been released. The crash-safe state. */
    drawLedgerTxId: text('draw_ledger_tx_id'),
    openedAt: tstz('opened_at').notNull().defaultNow(),
    drawnAt: tstz('drawn_at'),
    /**
     * When the CURRENT margin call started. NULL = not in one, and
     * `planLiquidation` refuses to liquidate while it is NULL. This column is
     * what makes "a margin call precedes liquidation" enforced rather than
     * intended.
     */
    marginCalledAt: tstz('margin_called_at'),
    /**
     * The last mark accepted for this loan, for the deviation breaker in
     * `prices.ts`. A PRICE, not a balance: what one unit of collateral was worth,
     * never an amount anybody holds.
     */
    lastMarkPrice: amount('last_mark_price'),
    lastMarkedAt: tstz('last_marked_at'),
    closedAt: tstz('closed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('loans_user_status_idx').on(t.userId, t.status), index('loans_open_idx').on(t.status)],
);

/**
 * COLLATERAL MOVEMENTS — a log, not a figure.
 *
 * How much collateral a loan holds right now is
 * `ledger.balance(user/<id>/<asset>/collateral/loan:<loanId>)`. This table exists
 * so the job is idempotent and a human can read the history.
 *
 * `unique(loan_id, sequence)` rather than keying on the loan alone: a borrower
 * curing a margin call by ADDING collateral is the best outcome available to
 * everyone involved, so it has to be expressible more than once per loan.
 *
 * `id` is the client retry key when the caller supplies it (same shape as
 * `loans.open`'s loanId). A timed-out or overlapping retry reuses `id` so
 * MAX+1 cannot mint a second lock. Omitted id is a new top-up.
 */
export const loanCollateralEvents = bank.table(
  'loan_collateral_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => loans.id),
    sequence: integer('sequence').notNull(),
    direction: collateralDirectionEnum('direction').notNull(),
    /** A RECORD of one completed movement, written once with its ledger tx id. */
    amount: amount('amount').notNull(),
    status: loanEventStatusEnum('status').notNull().default('pending'),
    ledgerTxId: text('ledger_tx_id'),
    rejectionCode: text('rejection_code'),
    createdAt: createdAt(),
    settledAt: tstz('settled_at'),
  },
  (t) => [
    uniqueIndex('loan_collateral_events_seq_idx').on(t.loanId, t.sequence),
    index('loan_collateral_events_loan_idx').on(t.loanId, t.status),
  ],
);

/**
 * ONE DAY OF INTEREST FOR ONE LOAN — the guard the whole accrual story rests on.
 *
 * `unique(loan_id, accrual_date)` makes "a job that runs twice charges once" a
 * property of the database rather than a hope about timers. Daily compounding
 * that double-applies is not a reporting error: it is a charge the borrower never
 * incurred, and from that day forward it compounds.
 *
 * THERE IS NO `ledgerTxId`, and its absence is the point. Loan interest
 * CAPITALISES — the day's charge increases the debt and moves no value — because
 * a borrower with an empty available balance cannot be debited nightly, and a
 * design that tried would liquidate people for not holding cash they had just
 * borrowed against. Value moves at repayment or liquidation; those tables carry
 * the tx ids.
 *
 * `principalBasis` is the debt the day was computed against, snapshotted so any
 * past day's arithmetic can be re-derived from its own row.
 */
export const loanInterestAccruals = bank.table(
  'loan_interest_accruals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => loans.id),
    accrualDate: date('accrual_date').notNull(),
    /** Snapshotted so a later APR change cannot rewrite history. */
    rateBps: integer('rate_bps').notNull(),
    principalBasis: amount('principal_basis').notNull(),
    interestAmount: amount('interest_amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    /** ONE ACCRUAL PER LOAN PER DAY, forever. */
    uniqueIndex('loan_interest_accruals_day_idx').on(t.loanId, t.accrualDate),
    index('loan_interest_accruals_date_idx').on(t.accrualDate),
  ],
);

/**
 * ONE APPROVED INTEREST CORRECTION (LOAN-05) — a new row, never an edit of a past day.
 *
 * `amount` is signed: below zero takes interest off, above zero adds interest the
 * bank failed to charge. Like a day of accrual it moves no value; `outstanding()`
 * adds it to the interest leg. Two different people proposed and approved it, and
 * the identity approval it consumed is unique, so one approval writes one row.
 * This table and `loan_interest_accruals` refuse UPDATE and DELETE (append-only
 * trigger, migration 20261024143716).
 */
export const loanAdjustments = bank.table(
  'loan_adjustments',
  {
    id: uuid('id').primaryKey(),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => loans.id),
    kind: text('kind').notNull(),
    /** A RECORD of one approved correction, signed; written once. */
    amount: amount('amount').notNull(),
    reason: text('reason').notNull(),
    proposedBy: text('proposed_by').notNull(),
    approvedBy: text('approved_by').notNull(),
    approvalId: text('approval_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('loan_adjustments_approval_idx').on(t.approvalId), index('loan_adjustments_loan_idx').on(t.loanId, t.createdAt)],
);

/** REPAYMENTS. Partial repayment is normal, so the key is (loan, sequence). */
export const loanRepayments = bank.table(
  'loan_repayments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => loans.id),
    sequence: integer('sequence').notNull(),
    /** RECORDS of one completed repayment. Interest settles before principal. */
    interestAmount: amount('interest_amount').notNull(),
    principalAmount: amount('principal_amount').notNull(),
    status: loanEventStatusEnum('status').notNull().default('pending'),
    ledgerTxId: text('ledger_tx_id'),
    rejectionCode: text('rejection_code'),
    createdAt: createdAt(),
    settledAt: tstz('settled_at'),
  },
  (t) => [uniqueIndex('loan_repayments_seq_idx').on(t.loanId, t.sequence), index('loan_repayments_loan_idx').on(t.loanId, t.status)],
);

/**
 * MARGIN CALLS — one row per call, so "was the borrower warned before their
 * collateral was sold" is a row you can point at.
 *
 * A margin call that exists only as a status on `loans` cannot answer that: the
 * status is cleared when the call is cured and the evidence goes with it. On the
 * day a borrower disputes a liquidation, the status says nothing; this table says
 * when they were told, at what LTV, and whether delivery was even attempted.
 */
export const loanMarginCalls = bank.table(
  'loan_margin_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => loans.id),
    sequence: integer('sequence').notNull(),
    ltvBps: integer('ltv_bps').notNull(),
    /**
     * What the borrower must post to clear the call — a FIGURE quoted at one
     * instant, written once and never revised. The next mark writes a new row.
     */
    cureCollateralAmount: amount('cure_collateral_amount').notNull(),
    calledAt: tstz('called_at').notNull().defaultNow(),
    graceExpiresAt: tstz('grace_expires_at').notNull(),
    /**
     * Delivery is a separate fact from the call. A call raised but not delivered
     * is still a call, and must be visible as such rather than
     * indistinguishable from one the borrower actually read.
     */
    notifiedAt: tstz('notified_at'),
    notifyError: text('notify_error'),
    clearedAt: tstz('cleared_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('loan_margin_calls_seq_idx').on(t.loanId, t.sequence), index('loan_margin_calls_open_idx').on(t.loanId)],
);

/**
 * ONE RUNG OF A LIQUIDATION LADDER.
 *
 * `unique(loan_id, tranche)` is what makes the ladder both possible and safe. The
 * recipe this replaces keyed on the loan alone — one liquidation per loan for all
 * time — which forbade partial liquidation outright and left dumping the whole
 * position into whatever book existed as the only legal action. That is the
 * behaviour that manufactures the bad debt a liquidation exists to prevent.
 *
 * The four allocations must sum to `proceeds`, checked in the database as well as
 * in `loanLiquidate`: every unit a borrower's collateral realised belongs to
 * someone, and an unallocated remainder is value nobody has claimed.
 */
export const loanLiquidations = bank.table(
  'loan_liquidations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => loans.id),
    tranche: integer('tranche').notNull(),
    ltvBps: integer('ltv_bps').notNull(),
    /** The mark this rung executed at, for the dispute nobody wants to have. */
    markPrice: amount('mark_price').notNull(),
    /** Grace waived rather than served. Auditable per event, not inferred. */
    graceWaived: boolean('grace_waived').notNull().default(false),
    collateralSold: amount('collateral_sold').notNull(),
    proceeds: amount('proceeds').notNull(),
    principalRepaid: amount('principal_repaid').notNull(),
    interestRepaid: amount('interest_repaid').notNull(),
    penalty: amount('penalty').notNull(),
    surplusReturned: amount('surplus_returned').notNull(),
    /** Principal the proceeds could not cover on a CLOSING rung — the bad debt. */
    shortfall: amount('shortfall').notNull().default('0'),
    status: loanEventStatusEnum('status').notNull().default('pending'),
    ledgerTxId: text('ledger_tx_id'),
    badDebtLedgerTxId: text('bad_debt_ledger_tx_id'),
    rejectionCode: text('rejection_code'),
    createdAt: createdAt(),
    settledAt: tstz('settled_at'),
  },
  (t) => [uniqueIndex('loan_liquidations_tranche_idx').on(t.loanId, t.tranche), index('loan_liquidations_loan_idx').on(t.loanId, t.status)],
);

// ═════════════════════════════════════════════════════════════════════════════
// CARDS (§8.1) — the LEDGER half. The live rail is `socket.live-issuer`.
// ═════════════════════════════════════════════════════════════════════════════
//
// Same three-kinds-of-column rule as everything above, and the temptation here
// is a specific one: a card feels like it should have a `spendable` or an
// `available_credit` on it. It does not, and cannot. What a card may spend is
// `ledger.balance(userAvailable(user, asset))` minus whatever is currently held
// against open authorisations — and BOTH halves of that are ledger reads. An
// authorisation's hold lives in `withdrawalHoldAccount(user, asset, authId)`,
// one account per authorisation, so "what is held" is a sum the ledger already
// knows and this schema deliberately does not mirror.
//
// The tables below store: a card (a name, a policy and an issuer handle), the
// DECISION taken on each authorisation, and a write-once record of each
// completed movement. Nothing accumulates.
//
// `simulated` is on the card row rather than derived from `issuer`, because a
// row that outlives the composition root that made it must still be able to say
// whether it was ever real.

export const cardStatusEnum = bank.enum('card_status', ['active', 'frozen', 'closed']);

/** What we told the issuer. `declined` is a first-class outcome, not an error row. */
export const cardDecisionEnum = bank.enum('card_decision', ['approved', 'declined']);

/** A capture takes value out; a reversal puts the unspent hold back. */
export const cardSettlementKindEnum = bank.enum('card_settlement_kind', ['capture', 'reversal']);

/**
 * A CARD — an issuer handle, a name, and two policy numbers.
 *
 * No balance and no credit line: this is a DEBIT instrument over an account the
 * user already has. `asset_id` is which of their balances it draws on.
 */
export const cards = bank.table(
  'cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    assetId: text('asset_id').notNull(),
    /**
     * What merchants charge this card in (§18).
     *
     * Equal to `asset_id` on every card issued before 0007, and on every card
     * issued since that wants no conversion — in which case no rate is ever
     * consulted and this column changes nothing. Where it DIFFERS, each
     * authorisation is quoted at the authorisation moment and that rate is
     * frozen onto `card_conversions`.
     */
    settlementAssetId: text('settlement_asset_id').notNull(),
    /** Programme id, which is also the ledger rail label — e.g. 'card-sim'. */
    issuer: text('issuer').notNull(),
    /**
     * FALSE WOULD MEAN A REAL CARD EXISTS. Nothing sets it false today, and
     * nothing can until `socket.live-issuer` is a contract rather than a row.
     */
    simulated: boolean('simulated').notNull().default(true),
    /** The issuer's own identifier for this card. */
    issuerRef: text('issuer_ref').notNull(),
    /** Four digits a human recognises the card by. Not a card number, and not part of one. */
    panTail: text('pan_tail').notNull(),
    status: cardStatusEnum('status').notNull().default('active'),
    /**
     * Who froze the card. `operator` is a freeze the owner cannot lift.
     * Null when the card is not frozen by a recorded actor.
     */
    frozenBy: text('frozen_by'),
    /** POLICY: the cashback rate this card was issued on. Snapshotted per capture. */
    cashbackBps: integer('cashback_bps').notNull().default(0),
    /**
     * POLICY: the largest single authorisation this card may approve.
     *
     * A ceiling, never a holding — no money path writes it, and it is not a
     * remaining allowance that counts down. A per-period allowance would be a
     * running total by another name, and the ledger already answers "how much
     * has this card spent" from the settlement records.
     */
    perAuthorizationLimit: amount('per_authorization_limit').notNull(),
    /** POLICY ceiling for a UTC day. NULL means no daily ceiling. Not a running total. */
    dailyLimit: amount('daily_limit'),
    /** POLICY ceiling for a UTC month. NULL means no monthly ceiling. Not a running total. */
    monthlyLimit: amount('monthly_limit'),
    /** POLICY ceiling for ATM cash in a UTC day. NULL means no cash ceiling. */
    cashLimit: amount('cash_limit'),
    channelOnline: boolean('channel_online').notNull().default(true),
    channelContactless: boolean('channel_contactless').notNull().default(true),
    channelAtm: boolean('channel_atm').notNull().default(true),
    channelAbroad: boolean('channel_abroad').notNull().default(true),
    cardType: text('card_type').notNull().default('virtual'),
    /** Delivery address for a physical card. NULL on a virtual card. Not a PAN. */
    shippingAddress: jsonb('shipping_address'),
    replacesCardId: uuid('replaces_card_id'),
    replacedByCardId: uuid('replaced_by_card_id'),
    replaceReason: text('replace_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** One card row per issuer handle — a re-delivered issue callback finds this one. */
    uniqueIndex('cards_issuer_ref_idx').on(t.issuer, t.issuerRef),
    index('cards_user_status_idx').on(t.userId, t.status),
  ],
);

/**
 * ONE AUTHORISATION — the decision, recorded whichever way it went.
 *
 * `unique(card_id, authorization_ref)` is the double-decide guard, and it is the
 * same shape as `transfer_executions`: an issuer WILL redeliver an
 * authorisation webhook, and a second delivery must return the first decision
 * rather than place a second hold on the same purchase.
 *
 * Declines are rows too. A card that says no is answering a question a user will
 * ask about later — "why was I declined at the till" — and a design that only
 * persisted approvals could not answer it.
 */
export const cardAuthorizations = bank.table(
  'card_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id),
    /** The issuer's reference for this authorisation. The business key. */
    authorizationRef: text('authorization_ref').notNull(),
    /** Where the purchase was presented: card-present, online, contactless, atm, or foreign. */
    channel: text('channel').notNull().default('card-present'),
    /**
     * WHAT MOVES, in the card's FUNDING asset. A RECORD of one request, written once.
     *
     * On a same-asset card this is also what the merchant asked for. On a card
     * with a settlement asset of its own it is the merchant's amount converted
     * at the frozen rate — because every posting against this authorisation
     * (hold, capture, reversal) is denominated in the funding asset, and a
     * column that sometimes meant one asset and sometimes another is how a
     * reversal comes to return the wrong number. What the merchant asked for is
     * on `card_conversions`, in the currency they asked for it in.
     */
    amount: amount('amount').notNull(),
    /** A category label from the issuer, for the user's own statement. Never a merchant's brand. */
    merchantCategory: text('merchant_category'),
    decision: cardDecisionEnum('decision').notNull(),
    /** The named reason, e.g. `bank.card_not_active`. NULL when approved. */
    declineCode: text('decline_code'),
    /** `pending` is the claim written before the hold is posted. Same reason as everywhere else. */
    status: loanEventStatusEnum('status').notNull().default('pending'),
    /** The hold. NULL on a decline, because a decline moves nothing. */
    holdLedgerTxId: text('hold_ledger_tx_id'),
    decidedAt: tstz('decided_at').notNull().defaultNow(),
    createdAt: createdAt(),
    settledAt: tstz('settled_at'),
  },
  (t) => [
    /** ONE DECISION PER AUTHORISATION, forever. */
    uniqueIndex('card_authorizations_ref_idx').on(t.cardId, t.authorizationRef),
    index('card_authorizations_card_idx').on(t.cardId, t.status),
  ],
);

/**
 * THE FROZEN RATE — one row per authorisation that needed a conversion (§18).
 *
 * Written in the SAME database transaction as the decision, by whichever caller
 * claimed that decision. That is what makes the pair unable to disagree: a
 * redelivered authorisation loses the insert on `card_authorizations` and never
 * reaches this table, so there is exactly one rate per purchase and it is the
 * rate the first decision was taken at.
 *
 * No row is written for a card whose settlement asset IS its funding asset. No
 * rate is consulted there, so the absence of a row is a readable fact rather
 * than an ambiguity, and `card_conversions_assets_differ` makes it structural.
 *
 * THIS IS NOT A RATE TABLE. Nothing reads it to price anything. Every row is a
 * record of a rate a feed handed us at a named instant, and a deployment with no
 * rate adapter cannot write one at all — it refuses `bank.mark_missing` instead,
 * because this platform has no FX source and a rate we stored as policy would be
 * a rate we invented.
 */
export const cardConversions = bank.table(
  'card_conversions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorizationId: uuid('authorization_id')
      .notNull()
      .references(() => cardAuthorizations.id),
    /** What the merchant charged, in the currency they charged it in. */
    settlementAssetId: text('settlement_asset_id').notNull(),
    settlementAmount: amount('settlement_amount').notNull(),
    /** What the user's balance is in — and what every posting here is denominated in. */
    fundingAssetId: text('funding_asset_id').notNull(),
    /** Ceil of settlement / rate. The rounding unit lands on the user, as cashback's does. */
    fundingAmount: amount('funding_amount').notNull(),
    /** Settlement units per ONE funding unit — the direction `PriceSource` returns. */
    rate: amount('rate').notNull(),
    /** `MarkQuality` from `loans/prices.ts`. Recorded, so an auditor can ask what kind of number moved this. */
    rateQuality: text('rate_quality').notNull(),
    /** When the FEED said it was true, not when we wrote the row. */
    rateAsOf: tstz('rate_as_of').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    /** ONE RATE PER AUTHORISATION, FOREVER. This index is the freeze. */
    uniqueIndex('card_conversions_auth_idx').on(t.authorizationId),
  ],
);

/**
 * A CAPTURE OR A REVERSAL — one completed movement against one authorisation.
 *
 * `unique(authorization_id, sequence)` rather than one row per authorisation,
 * because a partial capture produces BOTH: the merchant takes what they charged
 * and the unspent remainder of the hold goes back to the user in the same pass.
 * Two facts, two rows, each with its own ledger transaction id.
 *
 * The pair also has to be exhaustive. A hold account for an authorisation that
 * has been captured must end at zero — the capture plus the reversal equals what
 * was authorised — and `cards.test.ts` asserts that on the account itself rather
 * than on these rows, because the ledger is the one that has to be right.
 */
export const cardSettlements = bank.table(
  'card_settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorizationId: uuid('authorization_id')
      .notNull()
      .references(() => cardAuthorizations.id),
    sequence: integer('sequence').notNull(),
    kind: cardSettlementKindEnum('kind').notNull(),
    /** A RECORD of one completed movement; written once with its ledger tx id. */
    amount: amount('amount').notNull(),
    status: loanEventStatusEnum('status').notNull().default('pending'),
    ledgerTxId: text('ledger_tx_id'),
    rejectionCode: text('rejection_code'),
    createdAt: createdAt(),
    settledAt: tstz('settled_at'),
  },
  (t) => [
    uniqueIndex('card_settlements_seq_idx').on(t.authorizationId, t.sequence),
    index('card_settlements_auth_idx').on(t.authorizationId, t.status),
  ],
);

/**
 * CASHBACK ON ONE CAPTURE.
 *
 * Its own table and its own row status, so a reward that could not be paid is
 * VISIBLE as an unpaid reward rather than as an absence. The rewards pot is
 * funded from bank revenue and can be empty; when it is, the capture still
 * stands and this row says `rejected` with `bank.cashback_pot_unfunded` on it.
 * Any other ledger error leaves the row `pending`: the reward was not refused,
 * and `resumeSettlements` retries the same idempotent reward id.
 *
 * A design that swallowed the failure would leave a user quietly unpaid and an
 * operator with nothing to look at. A design that failed the capture would undo
 * a purchase that already happened because a marketing promise could not be
 * kept.
 */
export const cardCashback = bank.table(
  'card_cashback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorizationId: uuid('authorization_id')
      .notNull()
      .references(() => cardAuthorizations.id),
    /** Snapshotted, so re-rating the card later cannot rewrite what was promised. */
    rateBps: integer('rate_bps').notNull(),
    /** A RECORD of one reward; summing the table is the lifetime figure. */
    amount: amount('amount').notNull(),
    status: loanEventStatusEnum('status').notNull().default('pending'),
    ledgerTxId: text('ledger_tx_id'),
    rejectionCode: text('rejection_code'),
    createdAt: createdAt(),
    settledAt: tstz('settled_at'),
  },
  (t) => [
    /** ONE CASHBACK PER AUTHORISATION, forever. */
    uniqueIndex('card_cashback_auth_idx').on(t.authorizationId),
    index('card_cashback_status_idx').on(t.status),
  ],
);

// ── Ramps (§8.1 / D-S-09, crypto ledger half) ────────────────────────────────

export const rampKindEnum = bank.enum('ramp_kind', ['crypto', 'fiat']);

/**
 * ON-RAMP — value entering the book. Amount is a RECORD of one credit, written
 * once. No running total. Unique (rail, rail_ref) is the double-credit guard.
 */
export const rampOnramps = bank.table(
  'ramp_onramps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    assetId: text('asset_id').notNull(),
    amount: amount('amount').notNull(),
    kind: rampKindEnum('kind').notNull().default('crypto'),
    rail: text('rail').notNull(),
    railRef: text('rail_ref').notNull(),
    simulated: boolean('simulated').notNull().default(true),
    creditedBy: text('credited_by').notNull(),
    status: loanEventStatusEnum('status').notNull().default('pending'),
    ledgerTxId: text('ledger_tx_id'),
    rejectionCode: text('rejection_code'),
    createdAt: createdAt(),
    settledAt: tstz('settled_at'),
  },
  (t) => [
    uniqueIndex('ramp_onramps_rail_ref_idx').on(t.rail, t.railRef),
    index('ramp_onramps_user_idx').on(t.userId, t.createdAt),
    index('ramp_onramps_status_idx').on(t.status),
  ],
);

/**
 * OFF-RAMP — value leaving the book. Amount is a RECORD of one withdrawal
 * instruction. Unique (user_id, client_ref) so a retry is the same offramp.
 */
export const rampOfframps = bank.table(
  'ramp_offramps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    assetId: text('asset_id').notNull(),
    amount: amount('amount').notNull(),
    kind: rampKindEnum('kind').notNull().default('crypto'),
    rail: text('rail').notNull(),
    destinationRef: text('destination_ref').notNull(),
    clientRef: text('client_ref').notNull(),
    simulated: boolean('simulated').notNull().default(true),
    status: loanEventStatusEnum('status').notNull().default('pending'),
    holdLedgerTxId: text('hold_ledger_tx_id'),
    settleLedgerTxId: text('settle_ledger_tx_id'),
    releaseLedgerTxId: text('release_ledger_tx_id'),
    rejectionCode: text('rejection_code'),
    createdAt: createdAt(),
    settledAt: tstz('settled_at'),
  },
  (t) => [
    uniqueIndex('ramp_offramps_client_ref_idx').on(t.userId, t.clientRef),
    index('ramp_offramps_user_idx').on(t.userId, t.createdAt),
    index('ramp_offramps_status_idx').on(t.status),
  ],
);

/**
 * Where a user is paid out on withdraw — kind+ref asserted (IBAN/IFSC/EVM)
 * before insert. The `legacy` row is one per (user, kind) and is the one the offramp loads, so withdrawHold
 * never runs against an invented dest. A `customer` row is a saved address-book entry (migration 0043).
 */
export const userWithdrawDestinations = bank.table(
  'user_withdraw_destinations',
  {
    userId: text('user_id').notNull(),
    kind: text('kind').notNull(),
    ref: text('ref').notNull(),
    destinationId: uuid('destination_id').notNull().defaultRandom(),
    label: text('label'),
    assetId: text('asset_id'),
    network: text('network'),
    tag: text('tag'),
    origin: text('origin').notNull().default('legacy'),
    state: text('state').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // A look-alike saved after the customer confirmed it (migration 0054): the saved entry it was checked against, and when.
    lookalikeOf: uuid('lookalike_of'),
    lookalikeConfirmedAt: tstz('lookalike_confirmed_at'),
    // A new entry waits for the customer's approval (W-withdraw-09, migration 20261024100000): when and how it was approved.
    approvedAt: tstz('approved_at'),
    approvedBy: text('approved_by'),
    // The sign-in and trusted device that saved it, as the access token named them (migration 20261024130000).
    savedFam: uuid('saved_fam'),
    savedDev: uuid('saved_dev'),
  },
  (t) => [
    primaryKey({ name: 'user_withdraw_destinations_pkey', columns: [t.destinationId] }),
    uniqueIndex('user_withdraw_destinations_legacy_idx')
      .on(t.userId, t.kind)
      .where(sql`${t.origin} = 'legacy'`),
  ],
);

/**
 * Single-use links that approve a new withdrawal address (W-withdraw-09, migration 20261024100000). Only the token's
 * sha256 is kept; only the newest mailed link of an entry works, until it expires or is used.
 */
export const destinationApprovalLinks = bank.table(
  'destination_approval_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    destinationId: uuid('destination_id').notNull(),
    seq: integer('seq').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    mailedAt: tstz('mailed_at'),
    mailId: uuid('mail_id'),
    usedAt: tstz('used_at'),
  },
  (t) => [
    uniqueIndex('destination_approval_links_token_idx').on(t.tokenHash),
    uniqueIndex('destination_approval_links_seq_idx').on(t.destinationId, t.seq),
  ],
);

/** One removal per idempotency key. A retry reads this row and does not delete again. */
export const withdrawDestinationRemovals = bank.table(
  'withdraw_destination_removals',
  {
    userId: text('user_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    destinationId: uuid('destination_id').notNull(),
    removedAt: tstz('removed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'withdraw_destination_removals_pkey', columns: [t.userId, t.idempotencyKey] })],
);

/**
 * Signed-message proofs that a customer controls a saved wallet (W-withdraw-17, migration 0057). `pending` until the
 * saved address signs the message; then `verified` with the signature and how long the proof holds.
 */
export const walletOwnershipProofs = bank.table(
  'wallet_ownership_proofs',
  {
    id: uuid('id').primaryKey(),
    seq: bigint('seq', { mode: 'bigint' }).generatedAlwaysAsIdentity(),
    userId: text('user_id').notNull(),
    destinationId: uuid('destination_id').notNull(),
    address: text('address').notNull(),
    message: text('message').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    verifiedAt: tstz('verified_at'),
    validUntil: tstz('valid_until'),
    signature: text('signature'),
  },
  (t) => [index('wallet_ownership_proofs_entry_idx').on(t.userId, t.destinationId, t.status, t.seq.desc())],
);

/**
 * Terms a rate source published for one customer on-ramp quote.
 * Amounts are that source's decimals, not a balance.
 */
export const rampOnrampQuotes = bank.table('ramp_onramp_quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  assetId: text('asset_id').notNull(),
  amount: amount('amount').notNull(),
  method: text('method').notNull(),
  country: text('country').notNull(),
  payAmount: amount('pay_amount').notNull(),
  fee: amount('fee').notNull(),
  rate: amount('rate').notNull(),
  payCurrency: text('pay_currency').notNull(),
  expiresAt: tstz('expires_at').notNull(),
  simulated: boolean('simulated').notNull().default(true),
  /** How long the source says the money takes to arrive, in its words. Null: it did not say. */
  deliveryEstimate: text('delivery_estimate'),
  createdAt: createdAt(),
});

/**
 * Partner payment instruction for a customer on-ramp. Status stays
 * pending_payment: this row is not a ledger credit.
 */
export const customerOnramps = bank.table('customer_onramps', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull(),
  quoteId: uuid('quote_id').notNull(),
  method: text('method').notNull(),
  assetId: text('asset_id').notNull(),
  amount: amount('amount').notNull(),
  payAmount: amount('pay_amount').notNull(),
  fee: amount('fee').notNull(),
  rate: amount('rate').notNull(),
  payCurrency: text('pay_currency').notNull(),
  status: text('status').notNull().default('pending_payment'),
  simulated: boolean('simulated').notNull().default(true),
  partnerRail: text('partner_rail').notNull(),
  hostedUrl: text('hosted_url'),
  bankReference: text('bank_reference'),
  bankAccountName: text('bank_account_name'),
  bankAccountRef: text('bank_account_ref'),
  createdAt: createdAt(),
});

/**
 * One add-money request (J-bank-02): opened with a partner instruction, or refused with the rail and the reason.
 * A record of what was asked, never a balance or a credit.
 */
export const addMoneyRequests = bank.table('add_money_requests', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull(),
  assetId: text('asset_id').notNull(),
  amount: amount('amount').notNull(),
  method: text('method').notNull(),
  country: text('country').notNull(),
  rail: text('rail').notNull(),
  status: text('status').notNull(),
  refusalCode: text('refusal_code'),
  quoteId: uuid('quote_id'),
  onrampId: uuid('onramp_id'),
  createdAt: createdAt(),
});

/**
 * A customer's own account at another bank (BK-acct-02, migration 0055). Kept `unverified` until a banking partner
 * verifies it; one active link per (user, IBAN). Holds no amount.
 */
export const linkedBankAccounts = bank.table(
  'linked_bank_accounts',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull(),
    label: text('label').notNull(),
    holderName: text('holder_name').notNull(),
    iban: text('iban').notNull(),
    country: text('country').notNull(),
    state: text('state').notNull().default('unverified'),
    verifiedAt: tstz('verified_at'),
    createdAt: createdAt(),
    removedAt: tstz('removed_at'),
  },
  (t) => [
    uniqueIndex('linked_bank_accounts_active_iban_idx')
      .on(t.userId, t.iban)
      .where(sql`${t.removedAt} IS NULL`),
    index('linked_bank_accounts_user_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * One cash-out request to a linked bank account (J-bank-03, migrations 0056 and _cash_out_payouts). Kept refused with its
 * code when the bank cannot send it; otherwise held at confirm and settled, given back or returned once by the partner.
 */
export const cashOutRequests = bank.table('cash_out_requests', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull(),
  assetId: text('asset_id').notNull(),
  amount: amount('amount').notNull(),
  linkedAccountId: uuid('linked_account_id').notNull(),
  rail: text('rail').notNull().default('rail.bank'),
  status: text('status').notNull(),
  refusalCode: text('refusal_code'),
  payoutRail: text('payout_rail'),
  payoutRef: text('payout_ref'),
  fee: amount('fee'),
  receiveAmount: amount('receive_amount'),
  receiveCurrency: text('receive_currency'),
  holdLedgerTxId: text('hold_ledger_tx_id'),
  settleLedgerTxId: text('settle_ledger_tx_id'),
  reverseLedgerTxId: text('reverse_ledger_tx_id'),
  failureCode: text('failure_code'),
  returnedAmount: amount('returned_amount'),
  returnLedgerTxId: text('return_ledger_tx_id'),
  completedAt: tstz('completed_at'),
  failedAt: tstz('failed_at'),
  returnedAt: tstz('returned_at'),
  createdAt: createdAt(),
});

/** One send intent over a bank rail (J-bank-04 #1, migration 0058). Kept refused with its code; never held or posted. */
export const railSendIntents = bank.table('rail_send_intents', {
  id: uuid('id').primaryKey(),
  userId: text('user_id').notNull(),
  fromSpaceId: uuid('from_space_id').notNull(),
  assetId: text('asset_id').notNull(),
  amount: amount('amount').notNull(),
  rail: text('rail').notNull(),
  recipient: jsonb('recipient').notNull(),
  status: text('status').notNull(),
  refusalCode: text('refusal_code'),
  createdAt: createdAt(),
});

/** One saved bank-rail recipient (J-bank-04 #2, migration 0059). One live row per destination; removed rows stay. */
export const railPayees = bank.table('rail_payees', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  nickname: text('nickname').notNull(),
  country: text('country').notNull(),
  rail: text('rail').notNull(),
  recipient: jsonb('recipient').notNull(),
  destinationKey: text('destination_key').notNull(),
  createdAt: createdAt(),
  removedAt: tstz('removed_at'),
});

/** Address custody issued. Not a locally derived key and not a balance. */
export const depositAddresses = bank.table(
  'deposit_addresses',
  {
    userId: text('user_id').notNull(),
    assetId: text('asset_id').notNull(),
    networkId: text('network_id').notNull(),
    address: text('address').notNull(),
    memo: text('memo'),
    qrPayload: text('qr_payload'),
    createdAt: createdAt(),
    /** 0 is the first address, which never expires; an extra one (W-deposit-02) carries the expiry custody stored. */
    addressIndex: integer('address_index').notNull().default(0),
    label: text('label'),
    expiresAt: tstz('expires_at'),
  },
  (t) => [primaryKey({ name: 'deposit_addresses_pkey', columns: [t.userId, t.assetId, t.networkId, t.addressIndex] })],
);

/**
 * Which operation spent a money-out step-up approval (migration 0033). Written once
 * after identity consumes the approval; lets a retry of the SAME operation succeed and
 * refuses a different one. Ids and a payload hash only.
 */
export const stepUpUses = bank.table(
  'step_up_uses',
  {
    approvalId: text('approval_id').primaryKey(),
    userId: text('user_id').notNull(),
    sessionId: text('session_id').notNull(),
    actionType: text('action_type').notNull(),
    payloadHash: text('payload_hash').notNull(),
    operationKey: text('operation_key').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at').notNull().defaultNow(),
  },
  (t) => [index('step_up_uses_user_idx').on(t.userId, t.consumedAt)],
);

// ── Auto-invest (§31:805 F-plane) ────────────────────────────────────────────
// Rules are instructions; runs are write-once records. No balance column.

export const autoInvestKindEnum = bank.enum('auto_invest_kind', ['threshold_sweep', 'dca', 'card_roundup']);
export const autoInvestRuleStatusEnum = bank.enum('auto_invest_rule_status', ['active', 'paused', 'cancelled']);
export const autoInvestRunStatusEnum = bank.enum('auto_invest_run_status', ['pending', 'settled', 'rejected', 'skipped']);

export const autoInvestRules = bank.table(
  'auto_invest_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    kind: autoInvestKindEnum('kind').notNull(),
    assetId: text('asset_id').notNull(),
    threshold: amount('threshold'),
    targetPoolId: uuid('target_pool_id'),
    /** A card round-up into one of the person's own named spaces. Exactly one of this and `targetPoolId` on a round-up. */
    targetSpaceId: uuid('target_space_id').references(() => spaces.id),
    buyAssetId: text('buy_asset_id'),
    amount: amount('amount'),
    cadence: transferCadenceEnum('cadence'),
    nextRunAt: tstz('next_run_at'),
    status: autoInvestRuleStatusEnum('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('auto_invest_rules_user_idx').on(t.userId, t.status)],
);

export const autoInvestRuns = bank.table(
  'auto_invest_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => autoInvestRules.id),
    clientRunId: text('client_run_id').notNull(),
    status: autoInvestRunStatusEnum('status').notNull().default('pending'),
    amount: amount('amount'),
    ledgerTxId: text('ledger_tx_id'),
    positionId: text('position_id'),
    rejectionCode: text('rejection_code'),
    createdAt: createdAt(),
    settledAt: tstz('settled_at'),
  },
  (t) => [
    uniqueIndex('auto_invest_runs_unique_claim').on(t.ruleId, t.clientRunId),
    index('auto_invest_runs_rule_idx').on(t.ruleId, t.createdAt),
  ],
);

// ── Income sorter (BK-pots-03) ───────────────────────────────────────────────
// A payment from another person split across the person's own spaces by percentage, once. Instructions and what became
// of each split; every split moves with the own-space bankTransfer recipe, so no balance lives here.

export const incomeSorters = bank.table(
  'income_sorters',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull(),
    assetId: text('asset_id').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
    cancelledAt: tstz('cancelled_at'),
  },
  (t) => [
    uniqueIndex('income_sorters_one_active_uq')
      .on(t.userId, t.assetId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const incomeSorterLegs = bank.table(
  'income_sorter_legs',
  {
    sorterId: uuid('sorter_id')
      .notNull()
      .references(() => incomeSorters.id),
    position: smallint('position').notNull(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    shareBp: integer('share_bp').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sorterId, t.position] }), uniqueIndex('income_sorter_legs_space_uq').on(t.sorterId, t.spaceId)],
);

export const incomeSorterRuns = bank.table(
  'income_sorter_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sorterId: uuid('sorter_id')
      .notNull()
      .references(() => incomeSorters.id),
    /** The posted personal send this run sorts (bank.personal_transfers). */
    creditTransferId: text('credit_transfer_id').notNull(),
    creditTxId: text('credit_tx_id').notNull(),
    creditAmount: amount('credit_amount').notNull(),
    creditPostedAt: tstz('credit_posted_at').notNull(),
    /** below_minimum or terms_unset: recorded and not split. */
    skippedReason: text('skipped_reason'),
    createdAt: createdAt(),
    drivenAt: tstz('driven_at'),
  },
  (t) => [
    uniqueIndex('income_sorter_runs_credit_uq').on(t.creditTransferId),
    index('income_sorter_runs_sorter_idx').on(t.sorterId, t.createdAt.desc()),
  ],
);

export const incomeSorterRunLegs = bank.table(
  'income_sorter_run_legs',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => incomeSorterRuns.id),
    position: smallint('position').notNull(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    amount: amount('amount').notNull(),
    status: text('status').notNull().default('pending'),
    ledgerTxId: text('ledger_tx_id'),
    rejectionCode: text('rejection_code'),
    settledAt: tstz('settled_at'),
    attemptedAt: tstz('attempted_at'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.position] })],
);

// ── Business maker/checker (§31:811 partial) ─────────────────────────────────

export const businessMemberRoleEnum = bank.enum('business_member_role', [
  'admin',
  'maker',
  'checker',
  'signer',
  'editor',
  'viewer',
  'security_auditor',
  'non_signing_admin',
]);
export const businessApprovalStatusEnum = bank.enum('business_approval_status', ['pending', 'approved', 'rejected', 'cancelled']);

export const businessAccounts = bank.table('business_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  assetId: text('asset_id').notNull(),
  spendThreshold: amount('spend_threshold').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const businessMembers = bank.table(
  'business_members',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => businessAccounts.id),
    userId: text('user_id').notNull(),
    role: businessMemberRoleEnum('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('business_members_user_idx').on(t.userId)],
);

export const businessApprovals = bank.table(
  'business_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => businessAccounts.id),
    makerUserId: text('maker_user_id').notNull(),
    checkerUserId: text('checker_user_id'),
    fromSpaceId: uuid('from_space_id').notNull(),
    toSpaceId: uuid('to_space_id').notNull(),
    assetId: text('asset_id').notNull(),
    amount: amount('amount').notNull(),
    status: businessApprovalStatusEnum('status').notNull().default('pending'),
    transferId: text('transfer_id'),
    /** Purposed hold post while pending dual control. */
    holdLedgerTxId: text('hold_ledger_tx_id'),
    /** Settle (approve) post — null while pending or after release-only paths. */
    ledgerTxId: text('ledger_tx_id'),
    rejectionCode: text('rejection_code'),
    createdAt: createdAt(),
    decidedAt: tstz('decided_at'),
  },
  (t) => [index('business_approvals_account_status_idx').on(t.accountId, t.status)],
);

export const businessPayrollRuns = bank.table(
  'business_payroll_runs',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => businessAccounts.id),
    actorUserId: text('actor_user_id').notNull(),
    fromSpaceId: uuid('from_space_id').notNull(),
    assetId: text('asset_id').notNull(),
    ledgerTxId: text('ledger_tx_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('business_payroll_runs_account_idx').on(t.accountId, t.createdAt)],
);

export const businessMemberCommands = bank.table(
  'business_member_commands',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => businessAccounts.id),
    actorUserId: text('actor_user_id').notNull(),
    targetUserId: text('target_user_id').notNull(),
    action: text('action').notNull(),
    role: businessMemberRoleEnum('role'),
    createdAt: createdAt(),
  },
  (t) => [index('business_member_commands_account_idx').on(t.accountId, t.createdAt)],
);

export const businessControlRequests = bank.table(
  'business_control_requests',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => businessAccounts.id),
    kind: text('kind').notNull(),
    spendThreshold: amount('spend_threshold'),
    proposedBy: text('proposed_by').notNull(),
    confirmedBy: text('confirmed_by'),
    status: text('status').notNull(),
    createdAt: createdAt(),
    decidedAt: tstz('decided_at'),
  },
  (t) => [index('business_control_account_idx').on(t.accountId, t.createdAt)],
);

export const businessPayrollLines = bank.table(
  'business_payroll_lines',
  {
    payrollId: uuid('payroll_id')
      .notNull()
      .references(() => businessPayrollRuns.id),
    toSpaceId: uuid('to_space_id').notNull(),
    amount: amount('amount').notNull(),
  },
  (t) => [primaryKey({ columns: [t.payrollId, t.toSpaceId] })],
);

// Bills pot (BK-pots-03, J-bank-07 #4): one of the person's own named spaces per asset that pays their bills, with an
// opt-in fallback that tops it up from the main account when a standing order from it finds too little. A role, never a
// balance: the top-up is an own-space bankTransfer.

export const billsPots = bank.table(
  'bills_pots',
  {
    userId: text('user_id').notNull(),
    assetId: text('asset_id').notNull(),
    spaceId: uuid('space_id')
      .notNull()
      .unique('bills_pots_space_uq')
      .references(() => spaces.id),
    fallback: boolean('fallback').notNull().default(false),
    setAt: tstz('set_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.assetId] })],
);

// Shared pots (BK-acct-09, J-bank-07 #6): who may see a named pot (viewer) or add money to it (contributor), the invites
// that lead there with their owner-set lifetime, and the log of who did what. Membership decides who may call; it is
// never a balance, and the pot's money stays the owner's ledger account.
export const sharedPotInvites = bank.table(
  'shared_pot_invites',
  {
    /** The caller's own request id: asking again with it returns the same invite. */
    id: uuid('id').primaryKey(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    inviterUserId: text('inviter_user_id').notNull(),
    inviteeUserId: text('invitee_user_id').notNull(),
    role: text('role').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    /** created_at plus the owner's BANK_SHARED_POT_INVITE_MINUTES, on the database clock. */
    expiresAt: tstz('expires_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    declinedAt: tstz('declined_at'),
    cancelledAt: tstz('cancelled_at'),
  },
  (t) => [
    index('shared_pot_invites_invitee_idx').on(t.inviteeUserId, t.createdAt),
    index('shared_pot_invites_space_idx').on(t.spaceId, t.createdAt),
  ],
);

export const sharedPotMembers = bank.table(
  'shared_pot_members',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    userId: text('user_id').notNull(),
    role: text('role').notNull(),
    inviteId: uuid('invite_id')
      .notNull()
      .references(() => sharedPotInvites.id),
    joinedAt: tstz('joined_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.userId] }), index('shared_pot_members_user_idx').on(t.userId)],
);

export const sharedPotActivity = bank.table(
  'shared_pot_activity',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    actorUserId: text('actor_user_id').notNull(),
    subjectUserId: text('subject_user_id'),
    kind: text('kind').notNull(),
    role: text('role'),
    /** The card a card_* entry is about; null on every people entry. */
    cardId: uuid('card_id').references(() => cards.id),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('shared_pot_activity_space_idx').on(t.spaceId, t.id)],
);

/** The owner's card linked to a shared pot, so its holders can freeze it. One card per pot and one pot per card. */
export const sharedPotCards = bank.table(
  'shared_pot_cards',
  {
    spaceId: uuid('space_id')
      .primaryKey()
      .references(() => spaces.id),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id),
    linkedAt: tstz('linked_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('shared_pot_cards_card_uq').on(t.cardId)],
);

export const schema = {
  spaces,
  scheduledTransfers,
  transferExecutions,
  earnPools,
  earnPositions,
  interestAccruals,
  earnRateChanges,
  earnRenewals,
  earnPoolStatusChanges,
  loanProducts,
  loans,
  loanCollateralEvents,
  loanInterestAccruals,
  loanAdjustments,
  loanRepayments,
  loanMarginCalls,
  loanLiquidations,
  cards,
  cardAuthorizations,
  cardConversions,
  cardSettlements,
  cardCashback,
  rampOnramps,
  rampOfframps,
  userWithdrawDestinations,
  stepUpUses,
  autoInvestRules,
  autoInvestRuns,
  businessAccounts,
  businessMembers,
  businessApprovals,
  businessMemberCommands,
  businessControlRequests,
  businessPayrollRuns,
  businessPayrollLines,
};
