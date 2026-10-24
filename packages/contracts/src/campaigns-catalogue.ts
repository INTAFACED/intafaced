import { z } from 'zod';

/**
 * svc-campaigns campaign object, type catalogue and lifecycle (CM-campaign-types-01, with the time frame, weekday and
 * hour windows and the budget limit of CM-eligibility-rules-03; J-campaigns-01 #1-#3, #6, #7). Shared by the service and
 * the customer app. Browser-safe: zod only.
 *
 * Amounts are decimal strings, never numbers. A campaign holds no balance: its budget is a limit, and nothing in this
 * version reserves or spends against it (the reward saga and its counters are CM-payouts-ledger-02). Joining moves
 * nothing.
 */

/** Every refusal the campaign doors name. The code leads the tRPC message in brackets, `... [campaign.not_active]`. */
export const CAMPAIGN_REFUSAL_CODES = [
  'campaign.unknown',
  'campaign.name_taken',
  'campaign.type_unknown',
  'campaign.invalid_transition',
  'campaign.revision_conflict',
  'campaign.not_draft',
  'campaign.not_active',
  'campaign.outside_window',
  'campaign.archive_active',
  'campaigns.budget_unset',
  'campaigns.number_on_wire',
  'campaigns.rules_unset',
  'campaigns.time_frame_unset',
  'campaigns.timezone_unset',
  'campaigns.reward_unset',
  'campaigns.approval_required',
  'campaigns.second_person_required',
  'campaigns.eligibility_unwired',
  'campaigns.region_list_unset',
  'campaigns.not_eligible',
  'campaigns.region_blocked',
  'campaigns.participant_unread',
  'campaigns.review_not_needed',
  'owner.decision',
] as const;
export type CampaignRefusalCode = (typeof CAMPAIGN_REFUSAL_CODES)[number];

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

const id = z.string().min(1).max(128);
const iso = z.string().datetime({ offset: true });
/** A decimal string, zero or more, up to 18 places. */
export const campaignDecimal = z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,18})?$/);
const asset = z.string().regex(/^[A-Z0-9]{2,12}$/);

/** ISO weekday numbers, Monday 1 to Sunday 7, in the platform time zone. */
const weekday = z.number().int().min(1).max(7);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** The end of an hour window is exclusive; 24:00 runs to midnight. */
const hhmmEnd = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/);

/**
 * Who can take part (CM-eligibility-rules-01, ENGINE EL-1 to EL-3). Exclusions read svc-identity: `business` is the
 * account type chosen at sign-up, `institution` the institutional KYC tier. Identity holds no market-maker or staff
 * mark, so those two refuse `campaigns.eligibility_unwired`. A `listed` campaign refuses customers whose region is on
 * its restricted list, a compliance value: blank refuses activation `campaigns.region_list_unset`.
 */
export const participationRulesSchema = z.object({
  exclusions: z.array(z.enum(['business', 'institution', 'market_maker', 'staff'])).max(4),
  regionScope: z.enum(['platform', 'listed']),
  /** ISO 3166 alpha-2 regions that cannot take part. Only for `listed`; null while blank. */
  restrictedRegions: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .max(300)
    .nullable()
    .default(null),
});
export type ParticipationRules = z.infer<typeof participationRulesSchema>;

export const campaignBudgetSchema = z.object({
  asset,
  /** The most the campaign may ask the reward pot for. A limit, not a balance. */
  limit: campaignDecimal,
  /** What is not yet reserved or spent. Nothing reserves in this version (the reward saga does), so it equals the limit. */
  left: campaignDecimal,
});

export const campaignRewardSchema = z.object({ asset, amount: campaignDecimal });

export const campaignWindowsSchema = z.object({
  /** Null: every day. */
  weekdays: z.array(weekday).min(1).max(7).nullable(),
  /** Null: all day. `to` after `from`, both in the platform time zone; a window does not cross midnight. */
  hours: z.object({ from: hhmm, to: hhmmEnd }).nullable(),
});

/** The full stored definition, as operators see it. */
export const campaignSchema = z.object({
  id,
  name: z.string(),
  type: z.enum(CAMPAIGN_TYPES),
  state: z.enum(CAMPAIGN_STATES),
  revision: z.number().int().positive(),
  rules: z.string(),
  startsAt: iso.nullable(),
  endsAt: iso.nullable(),
  /** The platform time zone the windows are read in (an owner value); null while blank. */
  timeZone: z.string().nullable(),
  windows: campaignWindowsSchema,
  participation: participationRulesSchema.nullable(),
  budget: campaignBudgetSchema.nullable(),
  reward: campaignRewardSchema.nullable(),
  createdBy: z.string(),
  submittedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export type Campaign = z.infer<typeof campaignSchema>;

/**
 * The caller's own answer for one campaign. A refusal is one generic reason per rule (ENGINE EL-6): it names the rule,
 * never another person's history. `unread` means identity did not answer, which is never read as eligible.
 */
export const campaignEligibilitySchema = z.object({
  state: z.enum(['eligible', 'not_eligible', 'region_blocked', 'unread']),
  /** The caller's review request for this campaign, once filed. */
  review: z.object({ requestedAt: iso }).nullable(),
});
export type CampaignEligibility = z.infer<typeof campaignEligibilitySchema>;

/** One review request per campaign and account, `campaign:review:<campaignId>:<account>`; asking again returns it. */
export const campaignReviewResultSchema = z.object({
  review: z.object({ campaignId: id, requestedAt: iso }),
  /** False when the caller had already asked: the first request is returned. */
  created: z.boolean(),
});
export type CampaignReviewResult = z.infer<typeof campaignReviewResultSchema>;

/** `campaign:join:<campaignId>:<account>`: one participation per account; a retry returns this row. */
export const participationSchema = z.object({
  campaignId: id,
  participationKey: z.string(),
  revision: z.number().int().positive(),
  joinedAt: iso,
});
export type Participation = z.infer<typeof participationSchema>;

/** A published campaign as a customer sees it: no operator names. */
export const campaignViewSchema = z.object({
  id,
  name: z.string(),
  type: z.enum(CAMPAIGN_TYPES),
  state: z.enum(CUSTOMER_CAMPAIGN_STATES),
  rules: z.string(),
  startsAt: iso,
  endsAt: iso,
  timeZone: z.string(),
  windows: campaignWindowsSchema,
  participation: participationRulesSchema,
  budget: campaignBudgetSchema,
  /** Null reads "not set". */
  reward: campaignRewardSchema.nullable(),
  mine: participationSchema.nullable(),
  /** Read on a campaign's own page only; the catalogue and My campaigns leave it null. */
  eligibility: campaignEligibilitySchema.nullable(),
});
export type CampaignView = z.infer<typeof campaignViewSchema>;

export const campaignTypeViewSchema = z.object({
  type: z.enum(CAMPAIGN_TYPES),
  /** `owner.decision` for a parked type, else null. */
  blocker: z.literal('owner.decision').nullable(),
});

/** `catalogue.list`: the type list (parked types included) and every published campaign. */
export const campaignCatalogueSchema = z.object({
  types: z.array(campaignTypeViewSchema),
  campaigns: z.array(campaignViewSchema),
});
export type CampaignCatalogue = z.infer<typeof campaignCatalogueSchema>;

export const campaignGetInputSchema = z.object({ id }).strict();
export const campaignJoinInputSchema = z.object({ campaignId: id }).strict();
export const campaignReviewInputSchema = z.object({ campaignId: id }).strict();
export const campaignJoinResultSchema = z.object({
  participation: participationSchema,
  /** False when the account had already joined: the first participation is returned. */
  created: z.boolean(),
});
export type CampaignJoinResult = z.infer<typeof campaignJoinResultSchema>;

export const myCampaignSchema = z.object({ campaign: campaignViewSchema, participation: participationSchema });
export const myCampaignsSchema = z.object({ campaigns: z.array(myCampaignSchema) });
export type MyCampaigns = z.infer<typeof myCampaignsSchema>;

/**
 * Operator definition (`campaigns:ops`). Every field may be blank in a draft; the activation gate names each blank.
 * Amounts arrive as strings: a number refuses `campaigns.number_on_wire`.
 */
export const campaignDefinitionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.string().max(32),
    rules: z.string().max(4000).optional(),
    startsAt: z.string().max(64).nullish(),
    endsAt: z.string().max(64).nullish(),
    weekdays: z.array(weekday).min(1).max(7).nullish(),
    hours: z.object({ from: hhmm, to: hhmmEnd }).nullish(),
    participation: participationRulesSchema.nullish(),
    budget: z.object({ asset: z.string().max(16), limit: z.unknown() }).nullish(),
    reward: z.object({ asset: z.string().max(16), amount: z.unknown() }).nullish(),
  })
  .strict();
export type CampaignDefinitionInput = z.infer<typeof campaignDefinitionInputSchema>;

export const campaignUpdateInputSchema = z
  .object({ id, revision: z.number().int().positive(), definition: campaignDefinitionInputSchema })
  .strict();

/** A move keyed by (campaign, action, revision): the same move again returns the stored state. */
export const campaignTransitionInputSchema = z
  .object({ id, action: z.enum(CAMPAIGN_ACTIONS), revision: z.number().int().positive() })
  .strict();

/** The gate's answer: every blank by name, in order. Empty means the campaign may go live. */
export const campaignGateSchema = z.object({
  missing: z.array(z.object({ code: z.enum(CAMPAIGN_REFUSAL_CODES), field: z.string() })),
});
export type CampaignGate = z.infer<typeof campaignGateSchema>;

/** The calendar (ENGINE LC-6): a read over time frames in the platform time zone, with no state of its own. */
export const campaignCalendarSchema = z.object({
  timeZone: z.string().nullable(),
  entries: z.array(
    z.object({ id, name: z.string(), type: z.enum(CAMPAIGN_TYPES), state: z.enum(CAMPAIGN_STATES), startsAt: iso, endsAt: iso }),
  ),
});
export type CampaignCalendar = z.infer<typeof campaignCalendarSchema>;
