import { z } from 'zod';

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
  'campaigns.window_unset',
  'campaigns.welcome_none',
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

// ── Rule trees (CM-eligibility-rules-02, ENGINE EL-4) ─────────────────────────────────────────────────────────────

/**
 * A condition on one field of the account svc-identity describes (the campaign participant read): its type, its region,
 * its verification tier and its status. A closed list: no outside code runs, and no field is read from anywhere else.
 */
export const RULE_FIELDS = ['accountType', 'region', 'kycTier', 'status'] as const;
export type RuleField = (typeof RULE_FIELDS)[number];
const RULE_KYC_TIERS = ['none', 'basic', 'full', 'institutional'] as const;

export const ruleConditionSchema = z.discriminatedUnion('field', [
  z.object({ kind: z.literal('condition'), field: z.literal('accountType'), is: z.enum(['individual', 'business']) }).strict(),
  z
    .object({
      kind: z.literal('condition'),
      field: z.literal('region'),
      /** `in`: the account's region is one of these; `not_in`: it is none of them. No region recorded never passes. */
      test: z.enum(['in', 'not_in']),
      regions: z
        .array(z.string().regex(/^[A-Z]{2}$/))
        .min(1)
        .max(300),
    })
    .strict(),
  z.object({ kind: z.literal('condition'), field: z.literal('kycTier'), atLeast: z.enum(RULE_KYC_TIERS) }).strict(),
  z.object({ kind: z.literal('condition'), field: z.literal('status'), is: z.enum(['active', 'frozen', 'closed']) }).strict(),
]);
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

/** A group: all of its parts (`and`) or any of them (`or`). Depth and size limits are owner values, checked by the service. */
export type RuleGroup = { kind: 'group'; op: 'and' | 'or'; parts: RuleNode[] };
export type RuleNode = RuleGroup | RuleCondition;
export const ruleNodeSchema: z.ZodType<RuleNode> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal('group'), op: z.enum(['and', 'or']), parts: z.array(ruleNodeSchema).max(50) }).strict(),
    ruleConditionSchema,
  ]),
);
export const ruleGroupSchema = z
  .object({ kind: z.literal('group'), op: z.enum(['and', 'or']), parts: z.array(ruleNodeSchema).max(50) })
  .strict();

/** A rule as a campaign holds it: the library entry's name and revision, and a copy of its tree at that revision. */
export const campaignRuleSchema = z
  .object({ name: z.string().trim().min(1).max(120), revision: z.number().int().positive(), tree: ruleGroupSchema })
  .strict();
export type CampaignRule = z.infer<typeof campaignRuleSchema>;

/** A library entry: one name, many revisions; a campaign keeps the revision it took (ENGINE EL-4, LC-5). */
export const ruleLibraryEntrySchema = z.object({
  name: z.string(),
  revision: z.number().int().positive(),
  tree: ruleGroupSchema,
  createdBy: z.string(),
  createdAt: iso,
});
export type RuleLibraryEntry = z.infer<typeof ruleLibraryEntrySchema>;

export const ruleLibrarySaveInputSchema = z.object({ name: z.string().trim().min(1).max(120), tree: ruleGroupSchema }).strict();

/**
 * The fixture accounts a rule is tried on (ENGINE EL-4 `test`). Labelled TEST: illustrative accounts, never a customer.
 * Trying a rule reads no account and stores nothing.
 */
export const RULE_FIXTURES = [
  {
    id: 'test-business-kp',
    label: 'TEST business account, region KP, not verified',
    account: { accountType: 'business', region: 'KP', kycTier: 'none', status: 'active' },
  },
  {
    id: 'test-individual-de',
    label: 'TEST individual account, region DE, basic verification',
    account: { accountType: 'individual', region: 'DE', kycTier: 'basic', status: 'active' },
  },
  {
    id: 'test-individual-fr-frozen',
    label: 'TEST individual account, region FR, full verification, frozen',
    account: { accountType: 'individual', region: 'FR', kycTier: 'full', status: 'frozen' },
  },
  {
    id: 'test-individual-none',
    label: 'TEST individual account, no region recorded, full verification',
    account: { accountType: 'individual', region: null, kycTier: 'full', status: 'active' },
  },
] as const;
export type RuleFixtureId = (typeof RULE_FIXTURES)[number]['id'];

export const ruleTestInputSchema = z
  .object({ tree: ruleGroupSchema, fixture: z.enum(RULE_FIXTURES.map((f) => f.id) as [RuleFixtureId, ...RuleFixtureId[]]) })
  .strict();

/** A try of a rule on a fixture: whether it passes, and every condition that fails, by its place in the tree. */
export const ruleTestResultSchema = z.object({
  fixture: z.string(),
  passes: z.boolean(),
  failing: z.array(z.object({ path: z.string(), condition: ruleConditionSchema })),
});
export type RuleTestResult = z.infer<typeof ruleTestResultSchema>;

// ── Earning rules (CM-rewards-hub-05) ───────────────────────────────────────────────────────────────────────────────

/**
 * The triggers an earning rule may name: events declared in `packages/events`, each with the names its incentive
 * formula may read. `trade.fill.settled`: `amount` is the fill's quote amount, `fee` its fee, `qty` its quantity.
 * `pay.deposit_credit.posted`: `amount` is the amount credited. Anything else refuses `campaigns.trigger_unknown`.
 */
export const EARNING_TRIGGERS = {
  'trade.fill.settled': { label: 'A spot fill settles', names: ['amount', 'fee', 'qty'] },
  'pay.deposit_credit.posted': { label: 'A crypto deposit is credited', names: ['amount'] },
} as const;
export type EarningTrigger = keyof typeof EARNING_TRIGGERS;

/**
 * An earning rule: when its trigger's event arrives for a participant, and its condition holds, it gives the incentive
 * its formula works out, in the campaign's reward asset. A formula is parsed from a closed grammar (decimal numbers, the
 * trigger's names, `+ - * /`, brackets, `min(a, b)` and `max(a, b)`); anything else refuses `campaigns.formula_invalid`.
 * A fixed incentive is a formula that is one number. A rule is part of the campaign revision (ENGINE LC-5).
 */
export const earningRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    trigger: z.string().max(64),
    /** The condition on the event: its amount is at least this; null: any amount. */
    minAmount: campaignDecimal.nullable().default(null),
    formula: z.string().trim().min(1).max(200),
  })
  .strict();
export type EarningRule = z.infer<typeof earningRuleSchema>;

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
  /** A rule from the library (CM-eligibility-rules-02), checked against identity's answer on every join. */
  rule: campaignRuleSchema.nullish(),
});
export type ParticipationRules = z.infer<typeof participationRulesSchema>;

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

/**
 * Bus events a task step can complete from. `trade.fill`: a spot fill svc-trade settled for the account. A welcome
 * checklist (CM-rewards-hub-03) also has `identity.verified`, a verification tier svc-identity granted
 * (`identity.kyc.approved`), and `pay.deposit`, a crypto deposit svc-pay credited (`pay.deposit_credit.posted`); a
 * credit funded by a bonus, a trial fund or a gift is no deposit and never sends that event.
 */
export const TASK_EVENTS = ['trade.fill', 'identity.verified', 'pay.deposit'] as const;
export type TaskEvent = (typeof TASK_EVENTS)[number];

/** The verification a claim needs, read from svc-identity per claim and never stored here. */
export const KYC_GATES = ['none', 'basic', 'full'] as const;
export type KycGate = (typeof KYC_GATES)[number];

/** One step: `count` matching events, each counted once by its event id. A blank market or side matches any. */
export const taskStepSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    event: z.enum(TASK_EVENTS),
    market: z
      .string()
      .regex(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/)
      .nullable()
      .default(null),
    side: z.enum(['buy', 'sell']).nullable().default(null),
    count: z.number().int().min(1).max(1000),
    /**
     * A streak step: done on this many consecutive calendar days in the platform time zone, one matching event a day
     * (`count` is then 1). A missed day resets it at the zone's midnight. Null: a plain count of events.
     */
    streakDays: z.number().int().min(2).max(365).nullable().default(null),
    /** A welcome task's own reward (one per task); null reads "not set" and its claim refuses `campaigns.reward_unset`. */
    reward: campaignRewardSchema.nullish(),
  })
  .strict();
export type TaskStep = z.infer<typeof taskStepSchema>;

/** Where a bonus applies (CM-rewards-hub-02): a closed list; spot trading and withdrawal fees are never in it. */
export const BONUS_APPLIES_TO = ['derivatives', 'copy_trading', 'bots', 'fiat', 'other'] as const;
export type BonusAppliesTo = (typeof BONUS_APPLIES_TO)[number];

/**
 * How a claimed reward is given (CM-payouts-ledger-01 locked part, CM-rewards-hub-02). Null: paid to the customer's
 * balance. `locked`: held in a campaigns pot until the customer completes `step` within `seconds` of the lock; done, it
 * is paid to them; not done in time, it is forfeited once and never given again. `bonus`: held in a campaigns pot,
 * never withdrawable, and forfeited once when `expirySeconds` after the grant pass (whether any bonus profit becomes
 * withdrawable is an owner decision, LD-camp-06, still blank, so none does). Blank seconds refuse
 * `campaigns.lock_period_unset` or `campaigns.bonus_expiry_unset`; a bonus with no product refuses
 * `campaigns.bonus_scope_unset`. A locked reward or bonus is never in the customer's balance.
 */
export const rewardLockSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('locked'),
      seconds: z.number().int().min(60).max(31_536_000).nullable(),
      step: taskStepSchema.extend({ streakDays: z.null().default(null) }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('bonus'),
      expirySeconds: z.number().int().min(60).max(31_536_000).nullable(),
      appliesTo: z.array(z.enum(BONUS_APPLIES_TO)).max(BONUS_APPLIES_TO.length),
    })
    .strict(),
]);
export type RewardLock = z.infer<typeof rewardLockSchema>;

/**
 * A task campaign's steps, claim window, risk-review hold and verification gate. The claim window (seconds after the last
 * step completes) and the hold (seconds a claimed reward waits on hold before it is paid; 0 pays at once) are operator
 * values per campaign: blank refuses activation `campaigns.claim_window_unset` or `campaigns.hold_period_unset`, never a
 * default.
 */
export const campaignTasksSchema = z
  .object({
    steps: z.array(taskStepSchema).min(1).max(10),
    claimWindowSeconds: z.number().int().min(1).max(31_536_000).nullable(),
    holdSeconds: z.number().int().min(0).max(31_536_000).nullable().default(null),
    lock: rewardLockSchema.nullable().default(null),
    kycGate: z.enum(KYC_GATES),
    /**
     * A welcome campaign's window: seconds from each account's sign-up in which its tasks count and are claimed. Blank
     * refuses activation and every claim `campaigns.window_unset`, never a default. Absent on a task campaign.
     */
    welcomeWindowSeconds: z.number().int().min(1).max(31_536_000).nullish(),
  })
  .strict();
export type CampaignTasks = z.infer<typeof campaignTasksSchema>;

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

// ── Vouchers (CM-vouchers-coupons-01, CM-campaign-types-01 T-3) ────────────────────────────────────────────────────

/** A voucher instance's states (ENGINE VC-1). Issuing publishes one; claim and use are J-campaigns-08. */
export const VOUCHER_STATES = [
  'generated',
  'published',
  'active',
  'claimed',
  'partially_used',
  'used',
  'expired',
  'forfeited',
  'deactivated',
] as const;
export type VoucherState = (typeof VOUCHER_STATES)[number];

/**
 * A voucher of a voucher campaign. It keeps the revision it was issued under and that revision's reward as its face value:
 * a later approved revision changes the vouchers issued after it, never one already published (T-3). The face value is a
 * counter, not a balance: nothing is held for it.
 */
export const campaignVoucherSchema = z.object({
  id,
  campaignId: id,
  code: z.string(),
  revision: z.number().int().positive(),
  face: z.object({ asset, amount: campaignDecimal }),
  state: z.enum(VOUCHER_STATES),
  issuedBy: z.string(),
  issuedAt: iso,
});
export type CampaignVoucher = z.infer<typeof campaignVoucherSchema>;

/** A voucher code: 4 to 32 letters, digits or hyphens, stored upper case. With the campaign it is the issue's business key. */
export const voucherCode = z.string().regex(/^[A-Za-z0-9-]{4,32}$/);
export const voucherIssueInputSchema = z.object({ campaignId: id, code: voucherCode }).strict();
/** The most vouchers one read lists, newest first; the screen says when a campaign has at least this many. */
export const VOUCHER_LIST_LIMIT = 500;

export const voucherListInputSchema = z.object({ campaignId: id }).strict();

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

// ── Task progress, claims and the reward saga (CM-tasks-quests-01, CM-payouts-ledger-02) ─────────────────────────────

/**
 * A reward intent's state (ENGINE RW-1 to RW-11). `qualified`: written, not yet posted. `posting`: a post is in flight.
 * `posted`: the ledger booked it (with its transaction). `pending_funding`: the reward pot could not cover it, the same
 * key posts again later. `pending_retry`: the platform posting freeze refused it, the same key posts again after it lifts.
 * `unknown`: the answer was lost; only the same key is ever posted again. `withheld`: the account is frozen, nothing is
 * posted. `failed`: a definite refusal proved nothing was booked. `forfeited`: claimed after the claim window closed.
 * `held`: claimed and on hold for the campaign's risk-review period; it is released (to `qualified`, then posted) once
 * when the hold ends, or withheld if the account is no longer active then.
 */
export const REWARD_STATES = [
  'held',
  'qualified',
  'posting',
  'locked',
  'settling',
  'posted',
  'pending_funding',
  'pending_retry',
  'unknown',
  'withheld',
  'failed',
  'forfeited',
] as const;
export type RewardState = (typeof REWARD_STATES)[number];

/** One line of the redemption log: every attempt, with its outcome and typed reason. */
export const redemptionAttemptSchema = z.object({
  at: iso,
  outcome: z.enum(['held', 'released', 'qualified', 'posted', 'locked', 'unlocked', 'refused', 'unknown', 'withheld', 'forfeited']),
  reason: z.string().nullable(),
});
export type RedemptionAttempt = z.infer<typeof redemptionAttemptSchema>;

export const rewardRecordSchema = z.object({
  /** The business key, `task:<campaign>:<account>:<period>`; the ledger key is `reward:` and this. */
  rewardKey: z.string(),
  campaignId: id,
  asset,
  amount: campaignDecimal,
  state: z.enum(REWARD_STATES),
  /** The typed reason of the last refusal or of a forfeit; null once posted. */
  reason: z.string().nullable(),
  /** The ledger transaction once posted. */
  ledgerTxId: z.string().nullable(),
  createdAt: iso,
  postedAt: iso.nullable(),
  /** When a held reward's risk-review hold ends; null when the campaign pays at once. */
  holdUntil: iso.nullable(),
  /** `paid` to the balance, or given `locked` or as a `bonus` (see `rewardLockSchema`), as the campaign said at the claim. */
  form: z.enum(['paid', 'locked', 'bonus']),
  /** A locked reward or bonus once its lock posted: the lock transaction, when its condition ends or it expires. */
  lock: z
    .object({
      txId: z.string(),
      until: iso,
      /** A locked reward's condition: the step and how many of its events count so far. Null for a bonus. */
      condition: z.object({ title: z.string(), done: z.number().int().min(0), target: z.number().int().positive() }).nullable(),
      /** A bonus's products; empty for a locked reward. */
      appliesTo: z.array(z.enum(BONUS_APPLIES_TO)),
      /** The decided outcome once its condition is met or its time ran out; null while it waits. */
      outcome: z.enum(['unlock', 'forfeit']).nullable(),
    })
    .nullable(),
  /**
   * The rollback window (an owner value; null reads "not set") and when it closes for this reward. A value-moving
   * rollback needs a reversing recipe that does not exist yet, so it is never available here.
   */
  rollback: z.object({
    windowSeconds: z.number().int().positive().nullable(),
    closesAt: iso.nullable(),
    blocker: z.literal('campaigns.reclaim_unavailable'),
  }),
  attempts: z.array(redemptionAttemptSchema),
});
export type RewardRecord = z.infer<typeof rewardRecordSchema>;

/** The caller's own progress on one task campaign. Counts are of distinct events, so a redelivered event changes nothing. */
export const taskProgressSchema = z.object({
  campaignId: id,
  joined: z.boolean(),
  steps: z.array(
    z.object({
      index: z.number().int().min(0),
      title: z.string(),
      done: z.number().int().min(0),
      target: z.number().int().positive(),
      complete: z.boolean(),
      /** A streak step's run: null on a plain step. `reset` once a day was missed after the run began. */
      streak: z
        .object({
          days: z.number().int().min(0),
          best: z.number().int().min(0),
          /** The run that ends on the last day done: the one a missed day broke, or the one still alive. */
          lastRun: z.number().int().min(0),
          lastDay: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable(),
          resetsAt: iso.nullable(),
          reset: z.boolean(),
        })
        .nullable(),
    }),
  ),
  completed: z.number().int().min(0),
  total: z.number().int().min(0),
  /** When the last step completed; the claim window opens then. */
  completedAt: iso.nullable(),
  claimClosesAt: iso.nullable(),
  kycGate: z.enum(KYC_GATES),
  reward: rewardRecordSchema.nullable(),
});
export type TaskProgress = z.infer<typeof taskProgressSchema>;

export const taskProgressInputSchema = z.object({ campaignId: id }).strict();
export const taskClaimInputSchema = z.object({ campaignId: id }).strict();
export const taskClaimResultSchema = z.object({
  reward: rewardRecordSchema,
  /** False when the account had claimed before: the first claim's reward is returned. */
  created: z.boolean(),
});
export type TaskClaimResult = z.infer<typeof taskClaimResultSchema>;

/**
 * My Rewards hub (CM-rewards-hub-01, J-campaigns-03): every reward of the signed-in account, in plain status words.
 * `on_hold`: held for review, or withheld while the account is not active. `still_open`: qualified and not booked yet
 * (being posted, waiting for the pot, the platform posting freeze, or an answer that was lost). `posted`: booked, with the
 * ledger transaction. `locked`: a locked reward or bonus waiting on its condition or expiry, held in a campaigns pot and
 * never withdrawable (its total is the customer's restricted balance). `closed`: forfeited or failed, never paid. Totals are summed from the reward rows on each read, never
 * stored.
 */
export const REWARD_STATUSES = ['on_hold', 'still_open', 'locked', 'posted', 'closed'] as const;
export type RewardStatus = (typeof REWARD_STATUSES)[number];
export const REWARD_STATUS_OF = {
  held: 'on_hold',
  withheld: 'on_hold',
  qualified: 'still_open',
  posting: 'still_open',
  locked: 'locked',
  settling: 'locked',
  pending_funding: 'still_open',
  pending_retry: 'still_open',
  unknown: 'still_open',
  posted: 'posted',
  failed: 'closed',
  forfeited: 'closed',
} as const satisfies Record<RewardState, RewardStatus>;

export const myRewardSchema = rewardRecordSchema.extend({ campaignName: z.string(), status: z.enum(REWARD_STATUSES) });
export type MyReward = z.infer<typeof myRewardSchema>;
export const myRewardsSchema = z.object({
  rewards: z.array(myRewardSchema),
  /** One line per status and asset that has a reward, summed over every reward of the account. */
  totals: z.array(z.object({ status: z.enum(REWARD_STATUSES), asset, amount: campaignDecimal, count: z.number().int().positive() })),
  /** True when the account has more rewards than `rewards` lists (the newest ones are listed). */
  more: z.boolean(),
});
export type MyRewards = z.infer<typeof myRewardsSchema>;
export const myRewardsInputSchema = z.object({}).strict();

/**
 * The welcome checklist (CM-rewards-hub-03, J-campaigns-04): a `welcome` campaign's tasks for an account it was live for
 * at sign-up. Its window opens at sign-up (`identity.user.created`) and lasts the campaign's `welcomeWindowSeconds`.
 * Each task ticks once, from the first of its own events inside the window (never self-reported; the same event again
 * changes nothing), and is claimed once, inside the window, under `task:<campaign>:<account>:welcome:<event>`. `expired`:
 * the window passed before the task was claimed; nothing is written then. `campaign` is null for an account that signed
 * up while no welcome campaign was live (or before its sign-up was read): it has no checklist.
 */
export const WELCOME_TASK_STATES = ['open', 'done', 'claimed', 'expired'] as const;
export const welcomeChecklistSchema = z.object({
  /** `state`: claims are taken only while it is `active`; once paused or ended the checklist says so. */
  campaign: z.object({ id, name: z.string(), rules: z.string(), state: z.enum(CAMPAIGN_STATES) }).nullable(),
  signedUpAt: iso.nullable(),
  window: z.object({ opensAt: iso, closesAt: iso.nullable(), state: z.enum(['open', 'expired', 'unset']) }).nullable(),
  tasks: z.array(
    z.object({
      event: z.enum(TASK_EVENTS),
      title: z.string(),
      state: z.enum(WELCOME_TASK_STATES),
      /** When the event that ticked it happened. */
      doneAt: iso.nullable(),
      /** Null reads "not set". */
      reward: campaignRewardSchema.nullable(),
      /** The claimed reward with its redemption log. */
      record: rewardRecordSchema.nullable(),
    }),
  ),
});
export type WelcomeChecklist = z.infer<typeof welcomeChecklistSchema>;
export const welcomeListInputSchema = z.object({}).strict();
export const welcomeClaimInputSchema = z.object({ event: z.enum(TASK_EVENTS) }).strict();
/** `created` is false when the task was claimed before: the first claim's reward is returned. */
export const welcomeClaimResultSchema = taskClaimResultSchema;
export type WelcomeClaimResult = TaskClaimResult;

/** Operator reward records (founder-ops and finance): every intent with its account, newest first. */
export const payoutRecordSchema = rewardRecordSchema.extend({ accountId: z.string() });
export const payoutRecordListSchema = z.object({ records: z.array(payoutRecordSchema) });
export type PayoutRecordList = z.infer<typeof payoutRecordListSchema>;

/**
 * Funding the one reward pot from fee revenue the platform earned (`sweepFeesToRewards`): one operator asks, a different
 * one approves, and the approval posts under `token.fee.sweep:campaigns:<reference>:<module>:<asset>`. A refusal (the fee
 * account cannot cover it) is final for that reference.
 */
export const POT_SOURCE_MODULES = ['trade'] as const;
const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/);
export const potFundingSchema = z.object({
  reference,
  sourceModule: z.enum(POT_SOURCE_MODULES),
  asset,
  amount: campaignDecimal,
  state: z.enum(['requested', 'posting', 'posted', 'refused', 'unknown']),
  reason: z.string().nullable(),
  requestedBy: z.string(),
  approvedBy: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export type PotFunding = z.infer<typeof potFundingSchema>;
export const potFundingRequestInputSchema = z
  .object({ reference, sourceModule: z.enum(POT_SOURCE_MODULES), asset: z.string().max(16), amount: z.unknown() })
  .strict();
export const potFundingApproveInputSchema = z.object({ reference }).strict();
