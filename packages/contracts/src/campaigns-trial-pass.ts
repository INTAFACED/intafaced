import { z } from 'zod';
import { id, iso } from './campaigns-base.js';

/** The refusals a VIP trial pass (J-campaigns-14) names; `campaigns-kinds.ts` adds them to `CAMPAIGN_REFUSAL_CODES`. */
export const TRIAL_PASS_REFUSAL_CODES = [
  'campaigns.trial_pass_invalid',
  'campaigns.trial_pass_unset',
  'campaigns.not_trial_pass',
  'campaigns.trial_pass_refused',
  'campaigns.trial_pass_unreachable',
] as const;

// ── VIP trial passes (CM-vip-tiers-01, J-campaigns-14 #2 to #4) ─────────────────────────────────────────────────────

/**
 * A `trial_pass` campaign's terms: the fee tier its pass grants (a tier of the owner's tier programme on spend) and for
 * how many seconds. A pass is granted once per campaign and person, keyed `trial-pass:<campaign>:<account>`, and held by
 * svc-trade, which charges an order at the pass's tier while it is in force. A later pass replaces the one in force, and
 * a pass ends once. It pays nothing, so the campaign has no budget or reward. Blank terms refuse activation
 * `campaigns.trial_pass_unset`.
 */
export const campaignTrialPassSchema = z
  .object({
    tierId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]{1,64}$/)
      .refine((tier) => tier !== 'regular', 'a pass grants a tier above regular')
      .nullable(),
    seconds: z
      .number()
      .int()
      .min(60)
      .max(366 * 86_400)
      .nullable(),
  })
  .strict();
export type CampaignTrialPass = z.infer<typeof campaignTrialPassSchema>;

/** `ops.campaigns.trialPass.grant`: grants a live trial pass campaign's pass to one account, once. */
export const trialPassGrantInputSchema = z.object({ campaignId: id, accountId: id, reason: z.string().trim().min(3).max(500) }).strict();

/** A pass as svc-trade holds it. */
export const trialPassSchema = z
  .object({
    passKey: z.string(),
    campaignId: id,
    tierId: z.string(),
    startsAt: iso,
    endsAt: iso,
    grantedAt: iso,
    endedAt: iso.nullable(),
    endReason: z.enum(['expired', 'replaced']).nullable(),
    replacedBy: z.string().nullable(),
  })
  .strict();
export type TrialPass = z.infer<typeof trialPassSchema>;
export const trialPassGrantSchema = z
  .object({ pass: trialPassSchema, granted: z.boolean(), replaced: trialPassSchema.nullable() })
  .strict();
export type TrialPassGrant = z.infer<typeof trialPassGrantSchema>;
