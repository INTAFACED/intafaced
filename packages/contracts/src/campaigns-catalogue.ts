import { z } from 'zod';
import {
  CAMPAIGN_ACTIONS,
  CAMPAIGN_STATES,
  CAMPAIGN_TYPES,
  CUSTOMER_CAMPAIGN_STATES,
  campaignBudgetSchema,
  campaignRewardSchema,
  campaignWindowsSchema,
  hhmm,
  hhmmEnd,
  id,
  iso,
  weekday,
} from './campaigns-base.js';
import { earningRuleSchema } from './campaigns-earning.js';
import { CAMPAIGN_KIND_REFUSAL_CODES, campaignKindTerms, customerKindTerms } from './campaigns-kinds.js';
import { participationRulesSchema } from './campaigns-rules.js';
import { RISK_REFUSAL_CODES } from './campaigns-risk.js';
import { campaignTasksSchema } from './campaigns-tasks.js';
import { campaignLimitsSchema, feeSaverTermsSchema, voucherWindowSchema } from './campaigns-vouchers.js';

// The campaign's parts, one file each; importers keep reading them from here.
export {
  CAMPAIGN_ACTIONS,
  CAMPAIGN_STATES,
  CAMPAIGN_TYPES,
  CATALOGUE_CAMPAIGN_STATES,
  CUSTOMER_CAMPAIGN_STATES,
  PARKED_CAMPAIGN_TYPES,
  campaignBudgetSchema,
  campaignDecimal,
  campaignRewardSchema,
  campaignWindowsSchema,
  type CampaignAction,
  type CampaignState,
  type CampaignType,
} from './campaigns-base.js';
export * from './campaigns-earning.js';
export * from './campaigns-fee-saver.js';
export * from './campaigns-kinds.js';
export * from './campaigns-points.js';
export * from './campaigns-rewards.js';
export * from './campaigns-rules.js';
export * from './campaigns-tasks.js';
export * from './campaigns-vouchers.js';

/**
 * svc-campaigns campaign object, type catalogue and lifecycle (CM-campaign-types-01, with the time frame, weekday and
 * hour windows and the budget limit of CM-eligibility-rules-03; J-campaigns-01 #1-#3, #6, #7). Shared by the service and
 * the customer app. Browser-safe: zod only.
 *
 * Amounts are decimal strings, never numbers. A campaign holds no balance: its budget is a limit, and what its reward
 * intents reserve or spend is counted from those intents (CM-payouts-ledger-02). Joining moves nothing.
 *
 * Task campaigns (CM-tasks-quests-01, J-campaigns-02): steps that complete from verified events on the bus, a claim
 * window that opens when the last step completes, an optional verification gate, and one reward intent per claim
 * (`task:<campaign>:<account>:<period>`), paid once through the reward saga.
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
  'campaign.type_locked',
  'campaigns.rule_depth_unset',
  'campaigns.rule_size_unset',
  'campaigns.rule_too_deep',
  'campaigns.rule_too_large',
  'campaigns.rule_empty_group',
  'campaigns.rule_unknown',
  'campaigns.formula_invalid',
  'campaigns.trigger_unknown',
  'campaigns.earning_rule_name_taken',
  'campaigns.budget_below_drawn',
  'campaigns.budget_unset',
  'campaigns.number_on_wire',
  'campaigns.rules_unset',
  'campaigns.time_frame_unset',
  'campaigns.timezone_unset',
  'campaigns.timezone_not_platform',
  'campaigns.reward_unset',
  'campaigns.approval_required',
  'campaigns.second_person_required',
  'campaigns.eligibility_unwired',
  'campaigns.region_list_unset',
  'campaigns.not_eligible',
  'campaigns.region_blocked',
  'campaigns.participant_unread',
  'campaigns.review_not_needed',
  'campaigns.tasks_invalid',
  'campaigns.claim_window_unset',
  'campaigns.hold_period_unset',
  'campaigns.lock_period_unset',
  'campaigns.bonus_expiry_unset',
  'campaigns.bonus_scope_unset',
  'campaigns.no_tasks',
  'campaigns.not_joined',
  'campaigns.tasks_incomplete',
  'campaigns.kyc_required',
  'campaigns.claim_expired',
  'campaigns.budget_exhausted',
  'campaigns.budget_asset_mismatch',
  'campaigns.reward_saga_unwired',
  'campaigns.funding_unknown',
  'campaigns.funding_reference_taken',
  'campaigns.not_voucher',
  'campaigns.voucher_invalid',
  'campaigns.voucher_window_unset',
  'campaigns.voucher_window_invalid',
  'campaigns.voucher_code_taken',
  'campaigns.voucher_expired',
  'campaigns.voucher_amount_invalid',
  'campaigns.voucher_exceeds_remaining',
  'campaigns.voucher_sequence_invalid',
  'campaigns.voucher_not_cash',
  'campaigns.attempt_limit_unset',
  'campaigns.per_customer_limit_unset',
  'campaigns.customer_limit_reached',
  'campaigns.redemption_limit_reached',
  'campaigns.attempt_limit_reached',
  'campaigns.window_unset',
  'campaigns.welcome_none',
  // J-campaigns-17: the operator's watch desk, code batches and exports (campaigns-watch.ts).
  'campaigns.alert_threshold_unset',
  'campaigns.code_batch_limit_unset',
  'campaigns.code_batch_limit_exceeded',
  'campaigns.code_import_duplicate',
  'campaigns.code_batch_unknown',
  'campaigns.code_batch_reference_taken',
  'campaigns.voucher_unknown',
  'campaigns.voucher_deactivated',
  'campaigns.export_validity_unset',
  'campaigns.export_unknown',
  'campaigns.export_not_ready',
  'campaigns.export_expired',
  // J-campaigns-18: the risk review desk.
  ...RISK_REFUSAL_CODES,
  ...CAMPAIGN_KIND_REFUSAL_CODES,
  'owner.decision',
] as const;
export type CampaignRefusalCode = (typeof CAMPAIGN_REFUSAL_CODES)[number];

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
  /** The time zone the windows are read in (the platform zone, an owner value); null while it or the campaign's is blank. */
  timeZone: z.string().nullable(),
  /** True while the builder has left the campaign's own time zone blank (activation refuses `campaigns.timezone_unset`). */
  timeZoneBlank: z.boolean().default(false),
  windows: campaignWindowsSchema,
  participation: participationRulesSchema.nullable(),
  budget: campaignBudgetSchema.nullable(),
  reward: campaignRewardSchema.nullable(),
  /** Steps, claim window and gate of a task campaign; null for any other campaign, or a task campaign with no steps. */
  tasks: campaignTasksSchema.nullable(),
  /** How often one customer, and everyone together, may take this campaign's reward (CM-eligibility-rules-03). */
  limits: z.lazy(() => campaignLimitsSchema).nullish(),
  ...campaignKindTerms,
  /** A voucher campaign's claim-by and use-by times; absent or null for any other campaign. */
  vouchers: z.lazy(() => voucherWindowSchema).nullish(),
  /** Earning rules, in the order they are checked (CM-rewards-hub-05). */
  earning: z.array(earningRuleSchema).default([]),
  createdBy: z.string(),
  submittedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
  /**
   * An edit of a campaign past approval (ENGINE LC-5): revision n+1, waiting beside the live revision until a second
   * person approves it. Joins and rewards keep the revision they were made under. Null when there is none.
   */
  pendingChange: z
    .lazy(() => campaignChangeSchema)
    .nullable()
    .default(null),
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
  tasks: campaignTasksSchema.nullable(),
  ...customerKindTerms,
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
    /** Only for a `task` campaign: anything else refuses `campaigns.tasks_invalid`. */
    tasks: campaignTasksSchema.nullish(),
    /**
     * The time zone the time frame is typed in. Absent: the platform zone. Null: not picked yet, which refuses activation
     * `campaigns.timezone_unset`. In this version only the platform zone is accepted (`campaigns.timezone_not_platform`).
     */
    timeZone: z.string().max(64).nullish(),
    /** Earning rules (CM-rewards-hub-05); absent or null: none. */
    earning: z.array(earningRuleSchema).max(20).nullish(),
    /**
     * Only for a `voucher` campaign (anything else refuses `campaigns.voucher_window_invalid`): until when a voucher may be
     * claimed and until when a claimed one may be used. Either blank: every claim refuses `campaigns.voucher_window_unset`.
     */
    vouchers: z
      .object({
        claimBy: z.string().max(64).nullish(),
        useBy: z.string().max(64).nullish(),
        /**
         * A fee-saver coupon campaign (CM-vouchers-coupons-02, J-campaigns-09): each voucher takes `discountBps` of our
         * builder fee off (a fraction of the fee: 5000 is half of it) on up to `orders` venue orders, and moves no value.
         * Absent or null: a cash voucher, whose face value is the campaign's reward.
         */
        feeSaver: z.lazy(() => feeSaverTermsSchema).nullish(),
      })
      .strict()
      .nullish(),
    /** The campaign's limits; a blank per-customer limit refuses activation `campaigns.per_customer_limit_unset`. */
    limits: z.lazy(() => campaignLimitsSchema).nullish(),
    ...campaignKindTerms,
  })
  .strict();
export type CampaignDefinitionInput = z.infer<typeof campaignDefinitionInputSchema>;

/** A change of a live campaign: its revision, where it is, who wrote and asked, and the definition it would put live. */
export const campaignChangeSchema = z.object({
  revision: z.number().int().positive(),
  state: z.enum(['draft', 'pending_approval']),
  createdBy: z.string(),
  submittedBy: z.string().nullable(),
  definition: campaignDefinitionInputSchema,
  updatedAt: iso,
});
export type CampaignChange = z.infer<typeof campaignChangeSchema>;

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
