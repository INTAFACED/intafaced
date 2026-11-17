import { z } from 'zod';
import { campaignRewardSchema } from './campaigns-base.js';

/**
 * Bus events a task step can complete from. `trade.fill`: a spot fill svc-trade settled for the account. A welcome
 * checklist (CM-rewards-hub-03) also has `identity.verified`, a verification tier svc-identity granted
 * (`identity.kyc.approved`), and `pay.deposit`, a crypto deposit svc-pay credited (`pay.deposit_credit.posted`); a
 * credit funded by a bonus, a trial fund or a gift is no deposit and never sends that event. In a welcome checklist,
 * `pay.deposit` is read from the venue instead (J-campaigns-04 #2): a USDC deposit from a wallet the person connected
 * into the venue account it owns, as the venue reports it credited, counted only above what INTAFACED has paid that
 * wallet as rewards. A task campaign's step may be `pay.deposit` too (J-campaigns-02 #1), read from the venue the same
 * way: the first counting deposit seen after the person joined, inside the campaign's time frame, once per step.
 */
export const TASK_EVENTS = ['trade.fill', 'identity.verified', 'pay.deposit'] as const;
export type TaskEvent = (typeof TASK_EVENTS)[number];

/** The verification a claim needs, read from svc-identity per claim and never stored here. */
export const KYC_GATES = ['none', 'basic', 'full'] as const;
export type KycGate = (typeof KYC_GATES)[number];

/** One step: `count` matching events, each counted once by its event id. A blank market or side matches any. */
export const taskStepSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    event: z.enum(TASK_EVENTS),
    market: z
      .string()
      .regex(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/)
      .nullable()
      .default(null),
    side: z.enum(['buy', 'sell']).nullable().default(null),
    count: z.number().int().min(1).max(1000),
    /**
     * A streak step: done on this many consecutive calendar days in the platform time zone, one matching event a day
     * (`count` is then 1). A missed day resets it at the zone's midnight. Null: a plain count of events.
     */
    streakDays: z.number().int().min(2).max(365).nullable().default(null),
    /** A welcome task's own reward (one per task); null reads "not set" and its claim refuses `campaigns.reward_unset`. */
    reward: campaignRewardSchema.nullish(),
  })
  .strict();
export type TaskStep = z.infer<typeof taskStepSchema>;

/** Where a bonus applies (CM-rewards-hub-02): a closed list; spot trading and withdrawal fees are never in it. */
export const BONUS_APPLIES_TO = ['derivatives', 'copy_trading', 'bots', 'fiat', 'other'] as const;
export type BonusAppliesTo = (typeof BONUS_APPLIES_TO)[number];

/**
 * How a claimed reward is given (CM-payouts-ledger-01 locked part, CM-rewards-hub-02). Null: paid to the customer's
 * balance. `locked`: held in a campaigns pot until the customer completes `step` within `seconds` of the lock; done, it
 * is paid to them; not done in time, it is forfeited once and never given again. `bonus`: held in a campaigns pot,
 * never withdrawable, and forfeited once when `expirySeconds` after the grant pass (whether any bonus profit becomes
 * withdrawable is an owner decision, LD-camp-06, still blank, so none does). Blank seconds refuse
 * `campaigns.lock_period_unset` or `campaigns.bonus_expiry_unset`; a bonus with no product refuses
 * `campaigns.bonus_scope_unset`. A locked reward or bonus is never in the customer's balance.
 */
export const rewardLockSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('locked'),
      seconds: z.number().int().min(60).max(31_536_000).nullable(),
      step: taskStepSchema.extend({ streakDays: z.null().default(null) }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('bonus'),
      expirySeconds: z.number().int().min(60).max(31_536_000).nullable(),
      appliesTo: z.array(z.enum(BONUS_APPLIES_TO)).max(BONUS_APPLIES_TO.length),
    })
    .strict(),
]);
export type RewardLock = z.infer<typeof rewardLockSchema>;

/**
 * A task campaign's steps, claim window, risk-review hold and verification gate. The claim window (seconds after the last
 * step completes) and the hold (seconds a claimed reward waits on hold before it is paid; 0 pays at once) are operator
 * values per campaign: blank refuses activation `campaigns.claim_window_unset` or `campaigns.hold_period_unset`, never a
 * default.
 */
export const campaignTasksSchema = z
  .object({
    steps: z.array(taskStepSchema).min(1).max(10),
    claimWindowSeconds: z.number().int().min(1).max(31_536_000).nullable(),
    holdSeconds: z.number().int().min(0).max(31_536_000).nullable().default(null),
    lock: rewardLockSchema.nullable().default(null),
    kycGate: z.enum(KYC_GATES),
    /**
     * A welcome campaign's window: seconds from each account's sign-up in which its tasks count and are claimed. Blank
     * refuses activation and every claim `campaigns.window_unset`, never a default. Absent on a task campaign.
     */
    welcomeWindowSeconds: z.number().int().min(1).max(31_536_000).nullish(),
  })
  .strict();
export type CampaignTasks = z.infer<typeof campaignTasksSchema>;
