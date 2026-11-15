import { z } from 'zod';

/**
 * svc-identity trading checks (J-cex-spot-01 #3; OWNER 258 (4): "trading-only users get country and sanctions checks.
 * The full ID vendor comes with the bank."). The person gives their legal name and confirms the country they live in;
 * the service screens the name, the date of birth given at sign-up and the country against the owner's sanctions list
 * (NO DEFAULT: unset refuses `kyc.screening_list_unset` and clears nothing). No ID document, selfie or ID vendor.
 *
 * `held` is what a match reads as: the account is under review by a person, and the answer never says why.
 */
const alpha2 = z.string().regex(/^[A-Z]{2}$/);

export const kycTradingChecksSchema = z.object({
  state: z.enum(['not_run', 'cleared', 'held']),
  /** The country given at sign-up, for the person to confirm; null when none is on record. */
  country: alpha2.nullable(),
  /** False while the owner's list is blank: the check refuses until it is set. */
  listSet: z.boolean(),
});
export type KycTradingChecks = z.infer<typeof kycTradingChecksSchema>;

export const kycTradingChecksRunInputSchema = z
  .object({
    legalName: z.string().trim().min(2).max(200),
    country: alpha2,
    /** The person ticked "I live in <country>". */
    confirmed: z.literal(true),
  })
  .strict();
export type KycTradingChecksRunInput = z.infer<typeof kycTradingChecksRunInputSchema>;

export const kycTradingChecksResultSchema = z.object({ state: z.enum(['cleared', 'held']) });
export type KycTradingChecksResult = z.infer<typeof kycTradingChecksResultSchema>;
