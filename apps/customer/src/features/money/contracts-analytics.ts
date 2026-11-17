/** Spending analytics, budgets, plans, fees and what the partner bank holds back. */
import { z } from 'zod';
import { decimalSchema as money, signedDecimalSchema } from '../../shared/money';

export const analyticsSchema = z.object({
  assetId: z.string(),
  from: z.string(),
  to: z.string(),
  outflowByCategory: z.record(z.string(), money),
  totalOutflow: money,
  totalInflow: money,
  net: signedDecimalSchema,
  movements: z.number().int().nonnegative(),
});

/** BK-acct-08 (J-bank-16 #4): one budget with this month's spend, as the bank folds it. */
export const budgetSchema = z.object({
  assetId: z.string(),
  category: z.string(),
  period: z.string(),
  target: money,
  spent: money,
  progressBps: z.number().int(),
  alertBps: z.number().int(),
  alert: z.enum(['new', 'seen']).nullable(),
  alertShownAt: z.string().nullable(),
});
/** BK-acct-08 (J-bank-16 #5): months side by side by category; a month with no movement is "0". */
export const monthCompareSchema = z.object({
  assetId: z.string(),
  months: z.array(z.string()),
  categories: z.array(z.object({ category: z.string(), byMonth: z.array(money), change: z.string() })),
  totalOutflow: z.array(money),
  totalInflow: z.array(money),
});
export const leftToSpendSchema = z.object({ assetId: z.string(), period: z.string(), target: money, spent: money, left: z.string() });
/** BK-acct-04 (J-bank-16 #6): the owner's plans and the person's own; a paid plan names its blocker. */
const planSchema = z.object({
  id: z.string(),
  name: z.string(),
  tier: z.string(),
  price: money,
  assetId: z.string(),
  period: z.literal('month'),
});
export const plansSchema = z.object({
  plans: z.array(planSchema.extend({ blocker: z.literal('bank.plan_fee_unwired').nullable() })),
  current: planSchema,
});
/** BK-acct-04 (J-bank-16 #6): the partner's send limit and fee for a partner-held person, each null until it says. */
export const partnerLimitsSchema = z.discriminatedUnion('held', [
  z.object({ held: z.literal(false) }),
  z.object({
    held: z.literal(true),
    label: z.string(),
    assetId: z.string(),
    dailyLimit: money.nullable(),
    usedToday: money.nullable(),
    remainingToday: money.nullable(),
    sendFee: money.nullable(),
    asOf: z.string().nullable(),
  }),
]);
/**
 * J-wallet-01 #3: svc-bank `partnerHolds`. What a partner-held person can withdraw from their main balance at the partner,
 * and what the partner still holds back of their purchases, each with its release time, and each release once. `reported:
 * false` is a partner that does not report its holds: held back and withdrawable read "not reported", never 0.
 */
const partnerHoldSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  amount: money,
  paidBy: z.enum(['card', 'bank_pull']),
  releaseAt: z.string(),
});
export const partnerHoldsSchema = z.discriminatedUnion('held', [
  z.object({ held: z.literal(false) }),
  z.object({
    held: z.literal(true),
    label: z.string(),
    reported: z.boolean(),
    asOf: z.string().nullable(),
    balances: z.array(
      z.object({
        assetId: z.string(),
        balance: money.nullable(),
        balanceAsOf: z.string().nullable(),
        heldBack: money.nullable(),
        withdrawable: money.nullable(),
      }),
    ),
    holds: z.array(partnerHoldSchema),
    released: z.array(partnerHoldSchema.extend({ releasedAt: z.string() })),
  }),
]);
export type PartnerHolds = z.infer<typeof partnerHoldsSchema>;
/** BK-acct-04: the owner's account fee table; `set: false` is none published. */
export const accountFeesSchema = z.object({
  set: z.boolean(),
  lines: z.array(z.object({ id: z.string(), label: z.string(), fee: money, assetId: z.string() })),
});

/** This area's reads of svc-bank `bank.*`, composed into `bankReads` in contracts.ts. */
export const analyticsReads = {
  'analytics.spend': analyticsSchema,
  'analytics.budgets': z.array(budgetSchema),
  'analytics.leftToSpend': leftToSpendSchema,
  'analytics.compare': monthCompareSchema,
  'plans.list': plansSchema,
  'fees.account': accountFeesSchema,
  'fees.partner': partnerLimitsSchema,
  partnerHolds: partnerHoldsSchema,
  'fees.schedule.get': z.object({
    published: z.boolean(),
    entries: z.array(
      z.object({ assetId: z.string(), fee: money, free: z.boolean(), feeBlocker: z.string().nullable(), publishedAt: z.string() }),
    ),
  }),
} as const;

/** This area's writes to svc-bank `bank.*`, composed into `bankWrites` in contracts.ts. */
export const analyticsWrites = {
  'analytics.setBudget': budgetSchema,
  'analytics.budgetAlertShown': budgetSchema,
} as const;
