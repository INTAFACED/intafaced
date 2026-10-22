import { z } from 'zod';

/**
 * M-plat-org-09: statement descriptor validator shared by the merchant portal screen and svc-pay
 * (`merchant.businessProfile.submit`), so both refuse the same values before a change request is written.
 *
 * Rules taken from the cited source (stripe-account-settings-020, docs.stripe.com statement descriptors):
 * 5 to 22 characters, Latin letters, digits, spaces and basic punctuation, at least one letter, none of `< > \ ' " *`.
 * They are a source reference recorded for the owner, not an owner decision; the owner confirms them in the PR.
 */
export const MERCHANT_DESCRIPTOR_INVALID = 'merchant.descriptor_invalid' as const;
export const MERCHANT_DESCRIPTOR_MIN_LENGTH = 5;
export const MERCHANT_DESCRIPTOR_MAX_LENGTH = 22;

export type MerchantDescriptorProblem = 'too_short' | 'too_long' | 'banned_character' | 'no_letter' | 'edge_whitespace';

const ALLOWED = /^[A-Za-z0-9 .,\-&#/()+:;!?@_%$]*$/;

/** Returns the first problem, or null when the descriptor is valid. Exact characters, no trimming. */
export function merchantDescriptorProblem(value: string): MerchantDescriptorProblem | null {
  if (value !== value.trim()) return 'edge_whitespace';
  if (value.length < MERCHANT_DESCRIPTOR_MIN_LENGTH) return 'too_short';
  if (value.length > MERCHANT_DESCRIPTOR_MAX_LENGTH) return 'too_long';
  if (!ALLOWED.test(value)) return 'banned_character';
  if (!/[A-Za-z]/.test(value)) return 'no_letter';
  return null;
}

export const merchantStatementDescriptorSchema = z.string().superRefine((value, ctx) => {
  const problem = merchantDescriptorProblem(value);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: MERCHANT_DESCRIPTOR_INVALID, params: { problem } });
});
