import { z } from 'zod';

/**
 * The closed type list (ENGINE LC-1). Gift cards and the points programme are listed and parked: they wait for the
 * owner's answer (does INTAFACED sell gift cards; does it run a points programme whose points have value) and refuse
 * `owner.decision` at submission and activation.
 */
export const CAMPAIGN_TYPES = [
  'referral',
  'task',
  'voucher',
  'competition',
  'milestone',
  'draw',
  'pool',
  'distribution',
  'trial_pass',
  'gift_card',
  'points',
  'welcome',
] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];
export const PARKED_CAMPAIGN_TYPES = ['gift_card', 'points'] as const satisfies readonly CampaignType[];

export const CAMPAIGN_STATES = [
  'draft',
  'pending_approval',
  'approved',
  'scheduled',
  'active',
  'paused',
  'ended',
  'closed',
  'archived',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

/** States a customer can see on a campaign's page and in My campaigns. Drafts, approvals and archived rows are operator-only. */
export const CUSTOMER_CAMPAIGN_STATES = ['scheduled', 'active', 'paused', 'ended', 'closed'] as const satisfies readonly CampaignState[];
/** States the catalogue lists: campaigns still to come or still running. */
export const CATALOGUE_CAMPAIGN_STATES = ['scheduled', 'active', 'paused'] as const satisfies readonly CampaignState[];

/** Operator moves. `submit`: draft to pending_approval; `approve`: a second person; `activate`: scheduled or active. */
export const CAMPAIGN_ACTIONS = ['submit', 'approve', 'activate', 'pause', 'resume', 'end', 'close', 'archive'] as const;
export type CampaignAction = (typeof CAMPAIGN_ACTIONS)[number];

export const id = z.string().min(1).max(128);
export const iso = z.string().datetime({ offset: true });
/** A decimal string, zero or more, up to 18 places. */
export const campaignDecimal = z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,18})?$/);
export const asset = z.string().regex(/^[A-Z0-9]{2,12}$/);

/** ISO weekday numbers, Monday 1 to Sunday 7, in the platform time zone. */
export const weekday = z.number().int().min(1).max(7);
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** The end of an hour window is exclusive; 24:00 runs to midnight. */
export const hhmmEnd = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/);

export const campaignBudgetSchema = z.object({
  asset,
  /** The most the campaign may ask the reward pot for. A limit, not a balance. */
  limit: campaignDecimal,
  /** The limit less what its reward intents reserve or spent (every intent that is not failed, forfeited or withheld). */
  left: campaignDecimal,
});

export const campaignRewardSchema = z.object({ asset, amount: campaignDecimal });

export const campaignWindowsSchema = z.object({
  /** Null: every day. */
  weekdays: z.array(weekday).min(1).max(7).nullable(),
  /** Null: all day. `to` after `from`, both in the platform time zone; a window does not cross midnight. */
  hours: z.object({ from: hhmm, to: hhmmEnd }).nullable(),
});

/** A decimal that may be negative: a venue equity as the venue reports it. */
export const signedDecimal = z.string().regex(/^-?(0|[1-9]\d{0,19})(\.\d{1,18})?$/);
