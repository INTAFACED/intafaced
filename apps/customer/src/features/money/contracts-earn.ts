/** Savings pools and positions, and auto-invest rules. */
import { z } from 'zod';
import { decimalSchema as money } from '../../shared/money';

export const poolSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  kind: z.enum(['flexible', 'fixed']),
  name: z.string(),
  aprBps: z.number().int(),
  termDays: z.number().int().nullable(),
  minDeposit: money,
});
export const positionSchema = z.object({
  id: z.string(),
  poolId: z.string(),
  assetId: z.string(),
  principal: money,
  openedAt: z.string(),
  maturesAt: z.string().nullable(),
  /** The pool's recorded rate when the position opened; null when it opened before the pool's first record. */
  rateAtOpenBps: z.number().int().nullable(),
  /** The UTC midnight the position first earns from (BK-earn-01): a day pays positions opened before it began. */
  accruesFrom: z.string(),
  /** A closed pool's savings keep earning; a staking-style saving asked back earns nothing while `unbonding` (BK-earn-04). */
  accrual: z.enum(['waiting', 'accruing', 'below_unit', 'unbonding']),
  /** A fixed-term saving the saver asked to renew when its term ends (BK-earn-03). */
  autoRenew: z.boolean(),
  /** How many new terms auto-renew has started; `maturesAt` is the end of the current one. */
  renewals: z.number().int().nonnegative(),
  /** The next UTC day the bank pays this saving's interest (a date); null when no day pays it. */
  nextPayoutOn: z.string().date().nullable(),
  /** When an unbonding saving comes back to the main balance; null when it is not unbonding (BK-earn-04). */
  unbondsAt: z.string().datetime({ offset: true }).nullable(),
  /** The pool's unbonding period (BK-earn-04): taking this saving back starts it. Null: paid back at once. */
  unbondingDays: z.number().int().positive().nullable(),
  /** Staking-style only (BK-earn-04): staked, unbonding or unbonded by the bank's clock, never the device's. */
  staking: z.enum(['staked', 'unbonding', 'unbonded']).nullable(),
});
/**
 * What a pool publishes beyond its rate and term (svc-bank `earn.router.ts`, BK-earn-02 and BK-earn-05): how interest is
 * paid, in which asset, from where, and the owner tables that may be blank. A null is a figure nobody published.
 */
export const poolFacts = {
  payoutEvery: z.literal('day'),
  compounding: z.literal('simple'),
  rewardAssetId: z.string(),
  yieldSource: z.literal('pool_reserve'),
  rateBands: z.array(z.object({ from: money, rateBps: z.number().int() })).nullable(),
  commissionBps: z.number().int().nullable(),
  capacity: money.nullable(),
  /** A staking-style pool's unbonding period in days (BK-earn-04): taking a saving back starts it. Null: no unbonding. */
  unbondingDays: z.number().int().positive().nullable(),
};
export const earnPoolSchema = poolSchema.extend(poolFacts);
export const earnPoolPageSchema = earnPoolSchema.extend({ status: z.enum(['open', 'closed']) });
export const rateHistorySchema = z.object({
  poolId: z.string(),
  currentBps: z.number().int(),
  changes: z.array(z.object({ rateBps: z.number().int(), effectiveAt: z.string(), reason: z.string().nullable() })),
  earlier: z.boolean(),
});

export const ruleSchema = z.object({
  id: z.string(),
  kind: z.enum(['threshold_sweep', 'dca', 'card_roundup']),
  assetId: z.string(),
  threshold: money.nullable(),
  targetPoolId: z.string().nullable(),
  /** A card round-up into one of the person's own spaces (BK-pots-02). */
  targetSpaceId: z.string().nullable().optional(),
  buyAssetId: z.string().nullable(),
  amount: money.nullable(),
  cadence: z.enum(['daily', 'weekly', 'monthly']).nullable(),
  nextRunAt: z.string().nullable(),
  status: z.enum(['active', 'paused', 'cancelled']),
  createdAt: z.string(),
});

/** This area's reads of svc-bank `bank.*`, composed into `bankReads` in contracts.ts. */
export const earnReads = {
  'earn.pools': z.array(earnPoolSchema),
  'earn.pool': earnPoolPageSchema,
  'earn.rateHistory': rateHistorySchema,
  'earn.positions': z.array(positionSchema),
  /** The owner's staking risk wording (BK-earn-04); unpublished refuses `bank.earn_risk_wording_unset`. */
  'earn.riskDisclosure': z.object({ slashing: z.string(), ownership: z.string() }),
  'earn.interestHistory': z.object({
    days: z.array(z.object({ date: z.string(), rateBps: z.number().int(), amount: money, ledgerTxId: z.string() })),
    total: money,
    unitemisedDays: z.number().int(),
  }),
  'autoInvest.policy': z.object({
    enabled: z.boolean(),
    convertWired: z.boolean(),
    dcaRequiresConvert: z.literal(true),
    inventsRates: z.literal(false),
  }),
  'autoInvest.list': z.array(ruleSchema),
} as const;

/** This area's writes to svc-bank `bank.*`, composed into `bankWrites` in contracts.ts. */
export const earnWrites = {
  'earn.deposit': z.object({ positionId: z.string(), maturesAt: z.string().nullable() }),
  'earn.withdraw': z.object({
    positionId: z.string(),
    principal: money,
    /** `closed`: paid back to the main balance. `unbonding`: a staking-style saving's period began; back at `unbondsAt`. */
    status: z.enum(['closed', 'unbonding']),
    unbondsAt: z.string().datetime({ offset: true }).nullable(),
  }),
  'earn.setAutoRenew': z.object({ positionId: z.string(), autoRenew: z.boolean(), maturesAt: z.string().nullable() }),
  'autoInvest.createDca': ruleSchema,
  'autoInvest.createThresholdSweep': ruleSchema,
  'autoInvest.createRoundUp': ruleSchema,
  'autoInvest.pause': ruleSchema,
  'autoInvest.resume': ruleSchema,
  'autoInvest.cancel': z.object({ ok: z.literal(true) }),
} as const;
