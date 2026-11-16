import { z } from 'zod';
import { asset, campaignDecimal, campaignRewardSchema, id, iso } from './campaigns-base.js';

/** The refusals a referral programme (J-campaigns-06) names; `campaigns-kinds.ts` adds them to `CAMPAIGN_REFUSAL_CODES`. */
export const REFERRAL_REFUSAL_CODES = ['campaigns.referral_invalid', 'campaigns.criteria_unset'] as const;

// ── Referral programmes (CM-referral-02, J-campaigns-06) ─────────────────────────────────────────────────────────────

/**
 * What makes an invitee qualified under a referral programme (ENGINE EL-8, RF-5): the verification tier they reach, a
 * crypto deposit of at least `depositMin` and spot trades worth at least `tradeVolumeMin` (in fills quoted in `asset`),
 * each inside `windowSeconds` from the moment they were attached to their referrer. A deposit is only a crypto deposit
 * svc-pay credited (`pay.deposit_credit.posted`); moving money between the invitee's own wallet and venue accounts, or a
 * bonus, trial fund or gift, is no deposit and never counts. Every value is the operator's per programme: blank refuses
 * activation `campaigns.criteria_unset`, never a default.
 */
export const referralCriteriaSchema = z
  .object({
    verification: z.enum(['basic', 'full']).nullable(),
    asset: asset.nullable(),
    depositMin: campaignDecimal.nullable(),
    tradeVolumeMin: campaignDecimal.nullable(),
    windowSeconds: z.number().int().min(60).max(31_536_000).nullable(),
  })
  .strict();
export type ReferralCriteria = z.infer<typeof referralCriteriaSchema>;

/**
 * A `referral` campaign's programme: single sided (the referrer is rewarded) or double sided (both are), its criteria,
 * and each side's reward (CM-referral-03 pays them). A blank reward a side needs refuses activation `campaigns.reward_unset`.
 */
export const campaignReferralSchema = z
  .object({
    sides: z.enum(['single', 'double']),
    criteria: referralCriteriaSchema,
    rewards: z.object({ referrer: campaignRewardSchema.nullable(), referee: campaignRewardSchema.nullable() }).strict(),
  })
  .strict();
export type CampaignReferral = z.infer<typeof campaignReferralSchema>;

/** The steps a referrer sees for each invitee: done or not, never an amount, an event or who the invitee is. */
export const REFERRAL_STEPS = ['verified', 'deposited', 'traded'] as const;
export type ReferralStep = (typeof REFERRAL_STEPS)[number];

/**
 * One invitee as their referrer sees them (the bounded summary, ENGINE EL-6): their place in the order they joined, when
 * they were attached, each step done or not, and the summary state. `qualified` is reached once and never undone;
 * `window_closed`: the window passed before every step was done; `no_programme`: no referral programme was live when they
 * were attached, so nothing is tracked for them. No id, handle, email, amount or event detail of the invitee is returned.
 */
export const INVITEE_STATES = ['in_progress', 'qualified', 'window_closed', 'no_programme'] as const;
export const myInviteeSchema = z
  .object({
    place: z.number().int().positive(),
    attachedAt: iso,
    state: z.enum(INVITEE_STATES),
    steps: z.object({ verified: z.boolean(), deposited: z.boolean(), traded: z.boolean() }).strict(),
    qualifiedAt: iso.nullable(),
    windowClosesAt: iso.nullable(),
    programme: z.object({ id, name: z.string() }).nullable(),
  })
  .strict();
export type MyInvitee = z.infer<typeof myInviteeSchema>;
/** The most invitees one read lists, in the order they joined; `total` says when there are more. */
export const INVITEE_LIST_LIMIT = 200;
export const myInviteesSchema = z.object({ invitees: z.array(myInviteeSchema).max(INVITEE_LIST_LIMIT), total: z.number().int().min(0) });
export type MyInvitees = z.infer<typeof myInviteesSchema>;
export const myInviteesInputSchema = z.object({}).strict();
