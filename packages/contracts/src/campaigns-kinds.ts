/**
 * Every campaign kind with terms of its own, in one place. A new kind is a file of its own, `campaigns-<kind>.ts`
 * (its terms schema, its refusal codes and its reads), plus its lines here: `campaigns-catalogue.ts` takes the terms
 * fields and the refusal codes from this file and never names a kind's schemas itself (`campaigns-kinds.test.ts`).
 */
import { campaignCompetitionSchema, COMPETITION_REFUSAL_CODES } from './campaigns-competition.js';
import { campaignDistributionSchema, DISTRIBUTION_REFUSAL_CODES } from './campaigns-distribution.js';
import { campaignDrawSchema, DRAW_REFUSAL_CODES } from './campaigns-draw.js';
import { campaignPoolSchema, POOL_REFUSAL_CODES } from './campaigns-pool.js';
import { campaignReferralSchema, REFERRAL_REFUSAL_CODES } from './campaigns-referral.js';
import { campaignTrialPassSchema, TRIAL_PASS_REFUSAL_CODES } from './campaigns-trial-pass.js';

export * from './campaigns-competition.js';
export * from './campaigns-distribution.js';
export * from './campaigns-draw.js';
export * from './campaigns-pool.js';
export * from './campaigns-referral.js';
export * from './campaigns-trial-pass.js';

/**
 * Each kind's terms, as the stored campaign and the operator's definition hold them: absent or null for any other
 * campaign. In a definition, terms on a campaign of another type refuse `campaigns.<kind>_invalid`.
 */
export const campaignKindTerms = {
  /** A referral campaign's programme (CM-referral-02). */
  referral: campaignReferralSchema.nullish(),
  /** A competition's terms (CM-promotions-events-01). */
  competition: campaignCompetitionSchema.nullish(),
  /** A draw's terms (CM-promotions-events-02). */
  draw: campaignDrawSchema.nullish(),
  /** A distribution's terms (CM-airdrop-campaigns-01). */
  distribution: campaignDistributionSchema.nullish(),
  /** A reward pool's terms (CM-airdrop-campaigns-02). */
  pool: campaignPoolSchema.nullish(),
  /** A trial pass's terms (CM-vip-tiers-01). */
  trialPass: campaignTrialPassSchema.nullish(),
};

/** The terms a customer sees on a published campaign: every kind's, except a referral programme's. */
const { referral: _referral, ...customerTerms } = campaignKindTerms;
export const customerKindTerms = customerTerms;

/** Every kind's refusal codes, in `CAMPAIGN_REFUSAL_CODES`. */
export const CAMPAIGN_KIND_REFUSAL_CODES = [
  ...REFERRAL_REFUSAL_CODES,
  ...COMPETITION_REFUSAL_CODES,
  ...DRAW_REFUSAL_CODES,
  ...DISTRIBUTION_REFUSAL_CODES,
  ...POOL_REFUSAL_CODES,
  ...TRIAL_PASS_REFUSAL_CODES,
] as const;
