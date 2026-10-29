import { bigint, boolean, index, integer, jsonb, numeric, pgSchema, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { amount, bps, createdAt, tstz, updatedAt } from '@intafaced/db';

/**
 * THE NATIVE ECONOMY (§4.3).
 *
 * Sources, sinks and the flywheel — as tables. This service's schema, and only
 * this service's schema: svc-token is the *only* minter of IFC (§4.3), so every
 * other service reaches this data through the token API, never through SQL.
 * Doctrine §0.6 and the per-service Postgres roles both enforce it.
 *
 * Balances are NOT here. IFC balances live in svc-ledger like every other
 * asset; these tables hold the *rules* that decide what the ledger is told to
 * post.
 */
export const token = pgSchema('token');

/** §4.3 lock tiers. The tier is what fixes `multiplier_bps` and `unlocks_at`. */
export const stakeTierEnum = token.enum('stake_tier', ['flex', 'm3', 'm12']);

/**
 * `unstaking` is a distinct state, not a flag: an m3/m12 stake that has been
 * asked to unwind still counts for nothing in `stakeOf` but its principal is
 * not yet released, and the two must never be confused.
 */
export const stakeStatusEnum = token.enum('stake_status', ['pending', 'active', 'unstaking', 'closed']);

/** §4.3 governance surface: what an IFC-weighted vote is allowed to decide. */
export const proposalKindEnum = token.enum('proposal_kind', ['listing', 'fee_param', 'curriculum', 'grant']);

/**
 * §4.3 leaves the proposal status open; it is an enum rather than free text so
 * a future tally job and executor can branch on it without a typo silently
 * making a passed proposal un-executable.
 *
 * `closeProposal` writes `passed` | `rejected` from the tally vs owner env bps.
 * `executed` and `cancelled` are still never written — grant/listing close
 * returns `token.governance_execute_unwired` and does not move value. A future
 * `opens_at` stays `draft` until `openDueProposals` moves it to `open`.
 */
export const proposalStatusEnum = token.enum('proposal_status', [
  'draft',
  'open',
  'passed',
  'rejected',
  'executed',
  'cancelled',
  /** A non-basic voting type closed: only its ranking is stored until the owner decides what such a result means. */
  'closed_ranked',
]);

/** Abstains are recorded, not omitted — quorum maths needs to see them. */
export const voteChoiceEnum = token.enum('vote_choice', ['for', 'against', 'abstain']);

/**
 * Singleton row holding every tunable of the IFC economy (§4.3).
 *
 * These are parameters, not constants, because §4.3 hands parameter control to
 * governance (`proposal_kind = 'fee_param'`). Changing the emission curve or
 * the buyback share must therefore be a row update with an audit trail, never a
 * redeploy. Same one-row shape as svc-ledger's `chain_tip`.
 */
export const tokenParams = token.table('token_params', {
  /** Always `true`. The CHECK in the migration is what makes this a singleton. */
  id: boolean('id').primaryKey().default(true),
  /** Hard cap once an owner writes it. NULL is undecided — the mint refuses. */
  totalSupply: amount('total_supply'),
  /**
   * Emission schedule as data (§4.3). jsonb because the curve shape itself is
   * governable — a column per parameter would mean a migration per curve.
   * NULL until that write. An empty object is not a curve.
   */
  emissionCurve: jsonb('emission_curve'),
  /** Epochs between reward halvings. NULL until an owner writes the interval. */
  halvingInterval: integer('halving_interval'),
  /**
   * The published fee-decay schedule (§4.3): IFC balance/stake thresholds mapped
   * to discount bps. NULL until published. `feeCharge` refuses a blank schedule.
   */
  feeDiscountSchedule: jsonb('fee_discount_schedule'),
  /** Share of platform revenue per window routed into the buyback (§4.3). NULL until written. */
  buybackBps: bps('buyback_bps'),
  /** Of the tokens bought back, the share burned; the remainder funds rewards. NULL until written. */
  burnSplitBps: bps('burn_split_bps'),
  updatedAt: updatedAt(),
});

/**
 * Staked IFC positions (§4.3).
 *
 * The staked principal itself sits in a `stake`-kind ledger account; this row is
 * the *terms* of that stake — tier, multiplier, lock end — which the ledger has
 * no opinion about. `token.stakeOf` uses these rows as the claim index and
 * gates on ledger `tokenStakeAccount` balances; table/ledger drift refuses.
 */
export const stakes = token.table(
  'stakes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    amount: amount('amount').notNull(),
    tier: stakeTierEnum('tier').notNull(),
    /**
     * Reward weight, snapshotted at open (10000 = 1x).
     *
     * Copied off the tier rather than looked up at payout time, deliberately: a
     * governance change to tier multipliers must not retroactively re-price
     * stakes that were opened under the old terms.
     */
    multiplierBps: bps('multiplier_bps').notNull(),
    startedAt: tstz('started_at').notNull().defaultNow(),
    /** NULL only for `flex`, which has no lock. Enforced by CHECK in the migration. */
    unlocksAt: tstz('unlocks_at'),
    /**
     * Pending until the ledger post activates the row. An insert that omits
     * status is not yield-eligible. 0005 sets the same default on a book that
     * already applied 0000.
     */
    status: stakeStatusEnum('status').notNull().default('pending'),
    createdAt: createdAt(),
  },
  (t) => [
    /** The `stakeOf` read path: every gate in the OS hits this index. */
    index('stakes_user_status_idx').on(t.userId, t.status),
    /**
     * The pro-rata sweep over active stakes. §4.3 calls for a weekly job here;
     * there is no such job — `distributeRevenue` runs only when an operator
     * invokes it by hand (§13 socket `token.yield`). The index serves that
     * manual path today and the job when it is built.
     */
    index('stakes_status_idx').on(t.status),
    /** The unlock sweep asks "what matures next" — ordered by lock end. */
    index('stakes_unlocks_idx').on(t.unlocksAt),
  ],
);

/**
 * The mining emission schedule (§4.3).
 *
 * svc-token owns this table and svc-mining-pool (Phase 5) *requests* allocations
 * against it. Keeping `scheduled_amount` and `mined_amount` on the same row is
 * what lets the database itself refuse to over-mint (CHECK in the migration) —
 * the single most important property of the whole file.
 */
export const emissionEpochs = token.table('emission_epochs', {
  /** Natural key from §4.3 — epochs are a dense sequence, so no surrogate id. */
  epoch: integer('epoch').primaryKey(),
  /** What the curve allows this epoch. Derived from `token_params` at open. */
  scheduledAmount: amount('scheduled_amount').notNull(),
  /** What has actually been minted so far. Never exceeds the scheduled amount. */
  minedAmount: amount('mined_amount').notNull().default('0'),
  /**
   * Pool difficulty target for the epoch. numeric, not a float — precision loss
   * here would silently mis-price every share submitted against it.
   */
  difficulty: numeric('difficulty', { precision: 38, scale: 18 }).notNull().default('1'),
  /** Closed epochs are immutable; the scheduler refuses further allocations. */
  closed: boolean('closed').notNull().default(false),
  createdAt: createdAt(),
});

/**
 * One recorded burn cycle (§4.3 calls this buyback-and-burn).
 *
 * Live job `buyback.runWindow` sizes spend from houseFees, IOC market-buys on
 * the internal book, then burns the fill — `tokens_bought` on a settled row is
 * that fill, not an operator figure. Operator `recordBuyback` still takes a
 * typed `tokensBought` and refuses `token.buyback_tokens_unmoved` until a
 * market-buy books it. Empty book on the job is `token.buyback_book_empty`.
 * Window claim still happens first (0002).
 */
export const buybackRuns = token.table(
  'buyback_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The revenue window this run consumed, half-open [from, to).
     *
     * Stored as two columns rather than a range type so the unique index below
     * can make re-running a window impossible — spending the same revenue twice
     * would mint buy pressure out of nothing.
     */
    revenueWindowFrom: tstz('revenue_window_from').notNull(),
    revenueWindowTo: tstz('revenue_window_to').notNull(),
    /**
     * Per-asset revenue totals for the window, e.g. `{"USDT":"1200.5"}`. jsonb
     * because the asset set is data (svc-ledger seeds it) and grows without a
     * migration here.
     */
    revenueTotal: jsonb('revenue_total').notNull().default({}),
    tokensBought: amount('tokens_bought').notNull(),
    /** Sent to the burn address account. Together with the next column ≤ bought. */
    tokensBurned: amount('tokens_burned').notNull(),
    /** Sent to the rewards-engine account, funding real-yield staking payouts. */
    tokensToRewards: amount('tokens_to_rewards').notNull(),
    executedAt: tstz('executed_at').notNull().defaultNow(),
    createdAt: createdAt(),
    /**
     * When the last burn/post attempt started. NULL until one does.
     * The quiet period reads this, not `created_at` (the claim time).
     */
    lastPostAt: tstz('last_post_at'),
  },
  (t) => [
    /** A window is consumed exactly once, ever. See the migration's comment. */
    uniqueIndex('buyback_runs_window_idx').on(t.revenueWindowFrom, t.revenueWindowTo),
    index('buyback_runs_executed_idx').on(t.executedAt),
  ],
);

/**
 * Governance proposals (§4.3) — IFC-weighted, and the vehicle by which §17.3's
 * progressive decentralisation takes parameter control.
 */
export const proposals = token.table(
  'proposals',
  {
    /**
     * `gov:proposal:<space>:<author>:<ordinal>`. Not a client uuid.
     * List, get, vote, and close address this value.
     */
    id: text('id').primaryKey(),
    kind: proposalKindEnum('kind').notNull(),
    /**
     * The proposal payload — the listing to add, the parameter to change, the
     * grant to fund. Shape varies by `kind`, validated by the zod schema for
     * that kind before insert, so the column itself stays jsonb.
     */
    body: jsonb('body').notNull().default({}),
    status: proposalStatusEnum('status').notNull().default('draft'),
    opensAt: tstz('opens_at').notNull(),
    closesAt: tstz('closes_at').notNull(),
    createdAt: createdAt(),
    authorId: text('author_id'),
    title: text('title'),
    bodyMd: text('body_md'),
    discussionLink: text('discussion_link'),
    businessKey: text('business_key'),
    requestHandle: text('request_handle'),
    revision: integer('revision').notNull().default(1),
    ordinal: integer('ordinal'),
    spaceId: text('space_id'),
    /** `basic` (for/against/abstain) or one of the multi-choice types in `ballot-tally.ts`. */
    votingType: text('voting_type').notNull().default('basic'),
    /** Choice labels for a non-basic type, in index order. Null on `basic`. */
    choices: jsonb('choices'),
    /**
     * Seal of the voting power measured when the proposal was created: how
     * many snapshot rows, their total (the quorum electorate) and a sha256 of
     * the sorted rows. Null on proposals from before the snapshot.
     */
    snapshotCount: integer('snapshot_count'),
    snapshotTotal: amount('snapshot_total'),
    snapshotHash: text('snapshot_hash'),
    /** Choice indices, best first, written when a non-basic proposal closes. */
    ranking: jsonb('ranking'),
  },
  (t) => [
    /**
     * Close scans open proposals by window end. `closeProposal` is the caller.
     */
    index('proposals_status_closes_idx').on(t.status, t.closesAt),
    index('proposals_kind_idx').on(t.kind),
    index('proposals_author_created_idx').on(t.authorId, t.createdAt),
  ],
);

/** The one governance space. Creating more is not this slice. */
export const governanceSpaces = token.table('governance_spaces', {
  id: text('id').primaryKey(),
  createdAt: createdAt(),
});

/** Follow is a row whose `following` flag flips. A second follow of the same value changes nothing. */
export const governanceFollows = token.table(
  'governance_follows',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => governanceSpaces.id),
    accountId: text('account_id').notNull(),
    following: boolean('following').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.accountId] })],
);

/**
 * Who may propose, and how many times per period. Every column stays null
 * until an owner publishes it. Blank is not a compiled tier and not zero.
 */
export const governanceProposer = token.table('governance_proposer', {
  id: boolean('id').primaryKey().default(true),
  kind: text('kind'),
  minStake: amount('min_stake'),
  accounts: jsonb('accounts'),
  periodLimit: integer('period_limit'),
  periodMs: bigint('period_ms', { mode: 'bigint' }),
  updatedAt: updatedAt(),
});

/**
 * A single cast vote (§4.3).
 *
 * Weight is stake-derived, so it is money-precision even though it is not money
 * — a rounded vote weight is a mis-counted election.
 */
export const governanceVotes = token.table(
  'governance_votes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id),
    userId: text('user_id').notNull(),
    /**
     * Voting weight snapshotted when the vote was cast, not read at tally time.
     * Otherwise a voter could stake more after voting and retroactively amplify
     * a ballot already on the record.
     */
    weight: amount('weight').notNull(),
    /**
     * Eligible stake from the same read as `weight` — the sum of active
     * `tokenStakeAccount` pots when the ballot was cast. Close uses the
     * greatest of these. A later unstake must not shrink the quorum bar, and
     * a stake opened after the window must not raise it. NULL only on ballots
     * from before this column; close refuses those rather than reading live pots.
     */
    eligibleStake: amount('eligible_stake'),
    /** for/against/abstain on `basic` only. Null when `ballot` holds the vote; a non-basic abstain is `{ kind: 'abstain' }` there. */
    choice: voteChoiceEnum('choice'),
    /** A non-basic ballot as validated data (`ballot-tally.ts`). Exactly one of choice or ballot is set. */
    ballot: jsonb('ballot'),
    castAt: tstz('cast_at').notNull().defaultNow(),
    /** The linked wallet whose signature identity checked (lower-case). Null only on votes from before signed votes. */
    signedBy: text('signed_by'),
    /** The EIP-191 signature over the vote's message (`vote-signature.ts`), kept so the vote can be re-checked. */
    signature: text('signature'),
    /** The exact message the signature covers, as svc-token built it from the request. Null only on votes from before signed votes. */
    signedMessage: text('signed_message'),
  },
  (t) => [
    /** The tally reads every vote for one proposal — this is that scan. */
    index('governance_votes_proposal_idx').on(t.proposalId),
    /** One ballot per member per proposal. The anti-ballot-stuffing rule. */
    uniqueIndex('governance_votes_one_per_user_idx').on(t.proposalId, t.userId),
  ],
);

/**
 * Voting power per account, measured from the stake pots when a proposal is
 * created (MC-token-03). A ballot's weight is this row, never a client value
 * and never a later read: stake opened after creation has no row (power zero),
 * and an unstake after creation does not change it. Never spendable.
 */
export const governanceSnapshots = token.table(
  'governance_snapshots',
  {
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposals.id),
    userId: text('user_id').notNull(),
    power: amount('power').notNull(),
    takenAt: tstz('taken_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.userId] }), index('governance_snapshots_user_idx').on(t.userId, t.takenAt)],
);

/**
 * THAT A YIELD WINDOW WAS CLAIMED — including empty settlements (0004).
 *
 * `yield_payouts` freezes WHO is paid. This freezes THAT a window id was taken
 * for a given total, so an empty first run cannot be re-planned once somebody
 * stakes. Written once; a re-run with a different total is refused.
 */
export const yieldWindows = token.table('yield_windows', {
  windowId: text('window_id').primaryKey(),
  /** Operator-typed revenue total claimed for this window. Never updated. */
  totalAmount: amount('total_amount').notNull(),
  claimedAt: tstz('claimed_at').notNull().defaultNow(),
});

/**
 * WHO A YIELD WINDOW PAYS — frozen at plan time (0003).
 *
 * Not a balance and not a total: one row is one INSTRUCTION, written once when
 * a window is first distributed and never revised. The value itself is a
 * `rewardPay` transaction in the ledger, which `ledgerTxId` points at.
 *
 * It exists because the recipient list used to be recomputed from today's
 * active stakes on every call, which made `distributeRevenue`'s own
 * resumability promise false: a re-run after a new stake opened paid the
 * newcomer in full out of a window already distributed to the last attounit,
 * because their `(window, user)` reward key was the only one still unspent.
 *
 * An empty settlement writes ZERO rows here but still claims `yield_windows`
 * (0004) so the empty answer is frozen too.
 */
export const yieldPayouts = token.table(
  'yield_payouts',
  {
    windowId: text('window_id').notNull(),
    /** Same text as stakes.user_id (0007). 0003 declared this uuid. */
    userId: text('user_id').notNull(),
    /** The share owed. Written once — a column that changed would be a running total. */
    amount: amount('amount').notNull(),
    /** Null until the reward post for this row has returned. */
    ledgerTxId: text('ledger_tx_id'),
    paidAt: tstz('paid_at'),
    plannedAt: tstz('planned_at').notNull().defaultNow(),
  },
  (t) => [
    /** One payout per member per window — the pair the reward key already assumed. */
    primaryKey({ columns: [t.windowId, t.userId] }),
    /** The resume query: what this window still owes. */
    index('yield_payouts_unpaid_idx').on(t.windowId),
  ],
);

export const schema = {
  tokenParams,
  stakes,
  emissionEpochs,
  buybackRuns,
  proposals,
  governanceVotes,
  governanceSpaces,
  governanceFollows,
  governanceProposer,
  yieldWindows,
  yieldPayouts,
};
