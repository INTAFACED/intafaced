import { z } from 'zod';
import { iso } from './campaigns-base.js';

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
