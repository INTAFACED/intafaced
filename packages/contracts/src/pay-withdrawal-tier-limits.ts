import { z } from 'zod';

/**
 * svc-pay `withdrawal.tierLimits` (D-148, I-kyc-compliance-04): the owner's withdrawal limits for every KYC tier, as
 * the verification ladder shows them. Only figures the owner set are listed, per tier and asset; a tier or asset left
 * out has no limit set, and while limits are enforced a withdrawal there is refused (`pay.guard_withdrawal_limit_unset`).
 * `enforced` is false when the deployment applies no limits at all. Amounts are decimal strings in the asset's units.
 */
const payTierLimitAmountSchema = z.string().regex(/^\d+(\.\d{1,18})?$/);

export const payWithdrawalTierLimitsOutputSchema = z.object({
  enforced: z.boolean(),
  limits: z.array(
    z.object({
      tier: z.string().min(1).max(32),
      assetId: z.string().min(1).max(16),
      perTx: payTierLimitAmountSchema,
      rolling24h: payTierLimitAmountSchema,
    }),
  ),
});
export type PayWithdrawalTierLimits = z.infer<typeof payWithdrawalTierLimitsOutputSchema>;
