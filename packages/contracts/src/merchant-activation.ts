import { z } from 'zod';

/**
 * Whether a business is activated, as svc-pay records it (J-merchant-02 step 6, M-plat-org-13):
 * `merchantOps.activation.get`, the caller's own business only, for every team role.
 *
 * Confirmed means svc-pay holds a dated record of the business being set to `active`: the newest row of its append-only
 * merchant status history moves the business to `active`, and the business is still `active` now. `activatedAt` is that
 * row's time. Anything else is unconfirmed, with the reason:
 *   - `no_activation_record`: the business is `active` (as every account is when it opens) but no status change to
 *     `active` was ever recorded, so nothing confirms an activation;
 *   - `not_active`: the business is `pending`, `suspended` or `closed` now (`status` says which).
 *
 * It is never read from the verification (KYB) status: an approved verification does not activate a business, and an
 * activation says nothing about screening. The operator's name and written reason are not part of this read.
 */
export const MERCHANT_ACCOUNT_STATUSES = ['pending', 'active', 'suspended', 'closed'] as const;
export const merchantAccountStatusSchema = z.enum(MERCHANT_ACCOUNT_STATUSES);

export const MERCHANT_ACTIVATION_UNCONFIRMED_REASONS = ['no_activation_record', 'not_active'] as const;

export const merchantActivationSchema = z.discriminatedUnion('activation', [
  z
    .object({
      activation: z.literal('confirmed'),
      status: z.literal('active'),
      activatedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      activation: z.literal('unconfirmed'),
      status: merchantAccountStatusSchema,
      activatedAt: z.null(),
      reason: z.enum(MERCHANT_ACTIVATION_UNCONFIRMED_REASONS),
    })
    .strict(),
]);
export type MerchantActivation = z.infer<typeof merchantActivationSchema>;
