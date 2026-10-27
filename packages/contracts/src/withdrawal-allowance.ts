import { z } from 'zod';

/**
 * One customer's withdrawal allowance for one asset, as svc-pay's withdrawal limit guard applies it now (D-148,
 * J-ops-console-04 #12): the owner-set figures for the customer's KYC tier, a founder's override in force with its stored
 * end time (identity owns overrides; svc-pay reads them per request), the figures in force, what the rolling 24 hours used
 * and what is left. Amounts are decimal strings in the asset's own units. svc-pay answers it on
 * `founderAdmin.limits.customer`; the founder console shows it beside identity's overrides.
 */
const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');
const figures = z.object({ perTx: amount, rolling24h: amount }).strict();

export const withdrawalAllowanceInputSchema = z.object({ userId: z.string().guid(), assetId: z.string().min(1).max(16) }).strict();
export type WithdrawalAllowanceInput = z.infer<typeof withdrawalAllowanceInputSchema>;

export const withdrawalAllowanceSchema = z
  .object({
    tier: z.string(),
    assetId: z.string().min(1).max(16),
    base: figures,
    override: z
      .object({ perTx: amount.nullable(), rolling24h: amount.nullable(), expiresAt: z.string().datetime({ offset: true }) })
      .strict()
      .nullable(),
    perTx: amount,
    rolling24h: amount,
    used24h: amount,
    remaining: figures,
    maxNow: amount,
  })
  .strict();
export type WithdrawalAllowance = z.infer<typeof withdrawalAllowanceSchema>;
