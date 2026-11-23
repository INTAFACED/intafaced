/** Spending analytics, budgets, plans, fees and what the partner bank holds back. */
import { z } from 'zod';
import { decimalSchema as money } from '../../shared/money';

/** BK-acct-08 (J-bank-16 #5): months side by side by category; a month with no movement is "0". */
const monthCompareSchema = z.object({
  assetId: z.string(),
  months: z.array(z.string()),
  categories: z.array(z.object({ category: z.string(), byMonth: z.array(money), change: z.string() })),
  totalOutflow: z.array(money),
  totalInflow: z.array(money),
});
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

/** This area's reads of svc-bank `bank.*`, composed into `bankReads` in contracts.ts. */
export const analyticsReads = {
  'analytics.compare': monthCompareSchema,
  partnerHolds: partnerHoldsSchema,
} as const;

/** This area's writes to svc-bank `bank.*`, composed into `bankWrites` in contracts.ts. */
export const analyticsWrites = {} as const;
