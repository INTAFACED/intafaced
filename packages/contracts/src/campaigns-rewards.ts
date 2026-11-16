import { z } from 'zod';
import { CAMPAIGN_STATES, asset, campaignDecimal, campaignRewardSchema, id, iso } from './campaigns-base.js';
import { BONUS_APPLIES_TO, KYC_GATES, TASK_EVENTS } from './campaigns-tasks.js';

// ── Task progress, claims and the reward saga (CM-tasks-quests-01, CM-payouts-ledger-02) ─────────────────────────────

/**
 * A reward intent's state (ENGINE RW-1 to RW-11). `qualified`: written, not yet posted. `posting`: a post is in flight.
 * `posted`: the ledger booked it (with its transaction). `pending_funding`: the reward pot could not cover it, the same
 * key posts again later. `pending_retry`: the platform posting freeze refused it, the same key posts again after it lifts.
 * `unknown`: the answer was lost; only the same key is ever posted again. `withheld`: the account is frozen, nothing is
 * posted. `failed`: a definite refusal proved nothing was booked. `forfeited`: claimed after the claim window closed.
 * `held`: claimed and on hold for the campaign's risk-review period; it is released (to `qualified`, then posted) once
 * when the hold ends, or withheld if the account is no longer active then. `review`: held by the risk control
 * (J-campaigns-18): its account's own signals passed the owner's threshold; it keeps its place in the budget, nothing is
 * owed or posted, and only a person moves it (reason `risk.review`, or `risk.withheld` once a person withheld it).
 * `reclaiming`: an owed reward a risk decision is cancelling; the payer never pays it, and its reclaim posts once.
 * `cancelled`: reclaimed by a risk decision, once (`campaigns:reclaim:`); it holds nothing.
 */
export const REWARD_STATES = [
  'held',
  'review',
  'reclaiming',
  'cancelled',
  'qualified',
  'posting',
  'owed',
  'paid',
  'locked',
  'settling',
  'posted',
  'pending_funding',
  'pending_retry',
  'unknown',
  'withheld',
  'failed',
  'forfeited',
] as const;
export type RewardState = (typeof REWARD_STATES)[number];

/** One line of the redemption log: every attempt, with its outcome and typed reason. */
export const redemptionAttemptSchema = z.object({
  at: iso,
  outcome: z.enum([
    'held',
    'released',
    'qualified',
    'owed',
    'paid',
    'posted',
    'locked',
    'unlocked',
    'refused',
    'unknown',
    'withheld',
    'forfeited',
    'cancelled',
  ]),
  reason: z.string().nullable(),
});
export type RedemptionAttempt = z.infer<typeof redemptionAttemptSchema>;

export const rewardRecordSchema = z.object({
  /** The business key, `task:<campaign>:<account>:<period>`; the ledger key is `reward:` and this. */
  rewardKey: z.string(),
  campaignId: id,
  asset,
  amount: campaignDecimal,
  state: z.enum(REWARD_STATES),
  /** The typed reason of the last refusal or of a forfeit; null once posted. */
  reason: z.string().nullable(),
  /** The ledger transaction once posted. */
  ledgerTxId: z.string().nullable(),
  /**
   * A USDC reward INTAFACED owes (launch money model): the Owe transaction (`campaigns:owe:<rewardKey>`) and when it
   * booked. Owed is never in the customer's wallet or a balance: it is ours until it is paid to their own wallet.
   */
  owed: z.object({ txId: z.string(), at: iso }).nullable().default(null),
  /**
   * An owed reward paid to the customer's own wallet: the chain transaction that paid it, the wallet it went to (the one
   * connected when it was claimed), and when the payment was booked (`rewardPayOut`, keyed by that chain transaction).
   */
  payout: z
    .object({
      chainTx: z.string(),
      toWallet: z.string(),
      at: iso,
      /**
       * The network fee of the payment, as the chain's receipt reports it (gas used times its price, in the chain's own
       * coin), paid by INTAFACED's wallet: our cost, never taken from the reward. Null when the receipt did not say.
       */
      networkFee: z
        .object({ asset: z.string(), amount: campaignDecimal, paidBy: z.literal('intafaced') })
        .nullable()
        .default(null),
    })
    .nullable()
    .default(null),
  createdAt: iso,
  postedAt: iso.nullable(),
  /** When a held reward's risk-review hold ends; null when the campaign pays at once. */
  holdUntil: iso.nullable(),
  /** `paid` to the balance, or given `locked` or as a `bonus` (see `rewardLockSchema`), as the campaign said at the claim. */
  form: z.enum(['paid', 'locked', 'bonus']),
  /** A locked reward or bonus once its lock posted: the lock transaction, when its condition ends or it expires. */
  lock: z
    .object({
      txId: z.string(),
      until: iso,
      /** A locked reward's condition: the step and how many of its events count so far. Null for a bonus. */
      condition: z.object({ title: z.string(), done: z.number().int().min(0), target: z.number().int().positive() }).nullable(),
      /** A bonus's products; empty for a locked reward. */
      appliesTo: z.array(z.enum(BONUS_APPLIES_TO)),
      /** The decided outcome once its condition is met or its time ran out; null while it waits. */
      outcome: z.enum(['unlock', 'forfeit']).nullable(),
    })
    .nullable(),
  /**
   * The rollback window (an owner value; null reads "not set") and when it closes for this reward. A value-moving
   * rollback needs a reversing recipe that does not exist yet, so it is never available here.
   */
  rollback: z.object({
    windowSeconds: z.number().int().positive().nullable(),
    closesAt: iso.nullable(),
    /**
     * `payment`: a reward INTAFACED owes, whose rollback window closes when it is paid to the customer's wallet (a chain
     * payment cannot be taken back), at `closesAt` once paid, or earlier if the window runs out first. `posting`: the
     * window runs from the post.
     */
    closesOn: z.enum(['posting', 'payment']).default('posting'),
    blocker: z.literal('campaigns.reclaim_unavailable'),
  }),
  attempts: z.array(redemptionAttemptSchema),
});
export type RewardRecord = z.infer<typeof rewardRecordSchema>;

/** The caller's own progress on one task campaign. Counts are of distinct events, so a redelivered event changes nothing. */
export const taskProgressSchema = z.object({
  campaignId: id,
  joined: z.boolean(),
  steps: z.array(
    z.object({
      index: z.number().int().min(0),
      title: z.string(),
      done: z.number().int().min(0),
      target: z.number().int().positive(),
      complete: z.boolean(),
      /** A streak step's run: null on a plain step. `reset` once a day was missed after the run began. */
      streak: z
        .object({
          days: z.number().int().min(0),
          best: z.number().int().min(0),
          /** The run that ends on the last day done: the one a missed day broke, or the one still alive. */
          lastRun: z.number().int().min(0),
          lastDay: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable(),
          resetsAt: iso.nullable(),
          reset: z.boolean(),
        })
        .nullable(),
    }),
  ),
  completed: z.number().int().min(0),
  total: z.number().int().min(0),
  /** When the last step completed; the claim window opens then. */
  completedAt: iso.nullable(),
  claimClosesAt: iso.nullable(),
  kycGate: z.enum(KYC_GATES),
  reward: rewardRecordSchema.nullable(),
  /**
   * A deposit step's read of the venue (J-campaigns-02 #1): `read` with the venue's as-of time, `unread` when the venue or
   * the person's wallets could not be read (the step stays as it was, never "no deposit"), `no_wallet` with no wallet
   * connected. Null when the campaign has no deposit step or the person has not joined.
   */
  deposit: z
    .object({ source: z.enum(['read', 'unread', 'no_wallet']), asOf: iso.nullable() })
    .nullable()
    .default(null),
  /**
   * The campaign's budget, from its reward records: what is reserved (rewards owed or still being given, not yet paid),
   * what is spent (paid or posted) and what is left of the limit. `reserved + spent + left = limit` exactly while the
   * limit is not overdrawn. Null when the campaign has no budget set.
   */
  budget: z
    .object({ asset, limit: campaignDecimal, reserved: campaignDecimal, spent: campaignDecimal, left: campaignDecimal })
    .nullable()
    .default(null),
});
export type TaskProgress = z.infer<typeof taskProgressSchema>;

export const taskProgressInputSchema = z.object({ campaignId: id }).strict();
export const taskClaimInputSchema = z.object({ campaignId: id }).strict();
export const taskClaimResultSchema = z.object({
  reward: rewardRecordSchema,
  /** False when the account had claimed before: the first claim's reward is returned. */
  created: z.boolean(),
});
export type TaskClaimResult = z.infer<typeof taskClaimResultSchema>;

/**
 * My Rewards hub (CM-rewards-hub-01, J-campaigns-03): every reward of the signed-in account, in plain status words.
 * `on_hold`: held for review, or withheld while the account is not active. `still_open`: qualified and not booked yet
 * (being posted, waiting for the pot, the platform posting freeze, or an answer that was lost). `posted`: booked, with the
 * ledger transaction. `locked`: a locked reward or bonus waiting on its condition or expiry, held in a campaigns pot and
 * never withdrawable (its total is the customer's restricted balance). `owed`: a USDC reward INTAFACED owes and has not
 * paid to the customer's own wallet; an owed reward whose hold has not ended reads `on_hold`. `paid`: an owed reward paid
 * to the customer's own connected wallet, with its chain transaction. `closed`: forfeited or failed, never paid. Totals are summed from the reward rows on each read, never
 * stored.
 */
export const REWARD_STATUSES = ['on_hold', 'still_open', 'owed', 'paid', 'locked', 'posted', 'closed'] as const;
export type RewardStatus = (typeof REWARD_STATUSES)[number];
export const REWARD_STATUS_OF = {
  held: 'on_hold',
  review: 'on_hold',
  reclaiming: 'owed',
  cancelled: 'closed',
  withheld: 'on_hold',
  qualified: 'still_open',
  posting: 'still_open',
  owed: 'owed',
  paid: 'paid',
  locked: 'locked',
  settling: 'locked',
  pending_funding: 'still_open',
  pending_retry: 'still_open',
  unknown: 'still_open',
  posted: 'posted',
  failed: 'closed',
  forfeited: 'closed',
} as const satisfies Record<RewardState, RewardStatus>;

export const myRewardSchema = rewardRecordSchema.extend({ campaignName: z.string(), status: z.enum(REWARD_STATUSES) });
export type MyReward = z.infer<typeof myRewardSchema>;
export const myRewardsSchema = z.object({
  rewards: z.array(myRewardSchema),
  /** One line per status and asset that has a reward, summed over every reward of the account. */
  totals: z.array(z.object({ status: z.enum(REWARD_STATUSES), asset, amount: campaignDecimal, count: z.number().int().positive() })),
  /** True when the account has more rewards than `rewards` lists (the newest ones are listed). */
  more: z.boolean(),
});
export type MyRewards = z.infer<typeof myRewardsSchema>;
export const myRewardsInputSchema = z.object({}).strict();

/**
 * The welcome checklist (CM-rewards-hub-03, J-campaigns-04): a `welcome` campaign's tasks for an account it was live for
 * at sign-up. Its window opens at sign-up (`identity.user.created`) and lasts the campaign's `welcomeWindowSeconds`.
 * Each task ticks once, from the first of its own events inside the window (never self-reported; the same event again
 * changes nothing), and is claimed once, inside the window, under `task:<campaign>:<account>:welcome:<event>`. `expired`:
 * the window passed before the task was claimed; nothing is written then. `campaign` is null for an account that signed
 * up while no welcome campaign was live (or before its sign-up was read): it has no checklist.
 */
export const WELCOME_TASK_STATES = ['open', 'done', 'claimed', 'expired'] as const;
export const welcomeChecklistSchema = z.object({
  /** `state`: claims are taken only while it is `active`; once paused or ended the checklist says so. */
  campaign: z.object({ id, name: z.string(), rules: z.string(), state: z.enum(CAMPAIGN_STATES) }).nullable(),
  signedUpAt: iso.nullable(),
  window: z.object({ opensAt: iso, closesAt: iso.nullable(), state: z.enum(['open', 'expired', 'unset']) }).nullable(),
  tasks: z.array(
    z.object({
      event: z.enum(TASK_EVENTS),
      title: z.string(),
      state: z.enum(WELCOME_TASK_STATES),
      /** When the event that ticked it happened. */
      doneAt: iso.nullable(),
      /** Null reads "not set". */
      reward: campaignRewardSchema.nullable(),
      /** The claimed reward with its redemption log. */
      record: rewardRecordSchema.nullable(),
    }),
  ),
  /**
   * How the deposit task was read from the venue just now (J-campaigns-04 #2): `read` (with the venue's as-of time when
   * it was read now), `unread` (the venue or the connected wallets could not be read: nothing changed, and it is never
   * "no deposit"), or `no_wallet` (no wallet is connected, so there is no venue account to read). Null: no deposit task.
   */
  deposit: z.object({ source: z.enum(['read', 'unread', 'no_wallet']), asOf: iso.nullable() }).nullable(),
});
export type WelcomeChecklist = z.infer<typeof welcomeChecklistSchema>;
export const welcomeListInputSchema = z.object({}).strict();
export const welcomeClaimInputSchema = z.object({ event: z.enum(TASK_EVENTS) }).strict();
/** `created` is false when the task was claimed before: the first claim's reward is returned. */
export const welcomeClaimResultSchema = taskClaimResultSchema;
export type WelcomeClaimResult = TaskClaimResult;

/** Operator reward records (founder-ops and finance): every intent with its account, newest first. */
export const payoutRecordSchema = rewardRecordSchema.extend({ accountId: z.string() });
export const payoutRecordListSchema = z.object({ records: z.array(payoutRecordSchema) });
export type PayoutRecordList = z.infer<typeof payoutRecordListSchema>;

/**
 * Funding the one reward pot from fee revenue the platform earned (`sweepFeesToRewards`): one operator asks, a different
 * one approves, and the approval posts under `token.fee.sweep:campaigns:<reference>:<module>:<asset>`. A refusal (the fee
 * account cannot cover it) is final for that reference.
 */
/** Fee income the reward pot may be funded from: our own book's trade fees, or builder fees the venues credited us. */
export const POT_SOURCE_MODULES = ['trade', 'builder'] as const;
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/);
export const potFundingSchema = z.object({
  reference,
  sourceModule: z.enum(POT_SOURCE_MODULES),
  asset,
  amount: campaignDecimal,
  state: z.enum(['requested', 'posting', 'posted', 'refused', 'unknown']),
  reason: z.string().nullable(),
  requestedBy: z.string(),
  approvedBy: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export type PotFunding = z.infer<typeof potFundingSchema>;
export const potFundingRequestInputSchema = z
  .object({ reference, sourceModule: z.enum(POT_SOURCE_MODULES), asset: z.string().max(16), amount: z.unknown() })
  .strict();
export const potFundingApproveInputSchema = z.object({ reference }).strict();
