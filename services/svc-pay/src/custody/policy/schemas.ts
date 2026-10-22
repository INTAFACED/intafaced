import { z } from 'zod';

/**
 * Custody transaction policy (W-custody-ops-07). Rules are stored as the founder wrote them and checked by
 * `validateRules` (engine.ts) before they can be saved as a draft or published: the wire shape here is deliberately
 * loose (strings for amounts) so that a bad rule comes back as a per-rule problem, never as a silently dropped field.
 */
export const POLICY_ACTIONS = ['block', 'approve', 'additional_signers', 'allow'] as const;
export const POLICY_TX_TYPES = ['transfer', 'contract_call', 'approve', 'mint', 'raw', 'typed_message'] as const;
export const POLICY_UNITS = ['native', 'USD', 'EUR'] as const;

const text = z.string().max(200);
const list = z.array(text).max(500);

export const policyRuleSchema = z
  .object({
    id: text,
    action: z.enum(POLICY_ACTIONS),
    match: z
      .object({
        assets: list.optional(),
        networks: list.optional(),
        destinationKinds: list.optional(),
        destinationsIn: list.optional(),
        destinationsNotIn: list.optional(),
        txTypes: z.array(z.enum(POLICY_TX_TYPES)).max(POLICY_TX_TYPES.length).optional(),
        initiators: list.optional(),
        amountOver: z.object({ amount: text, unit: z.enum(POLICY_UNITS) }).strict().optional(),
        cumulativeOver: z.object({ amount: text, unit: z.enum(POLICY_UNITS), windowSeconds: z.number().int() }).strict().optional(),
      })
      .strict(),
    approval: z
      .object({ members: list, threshold: z.number().int(), initiatorMayApprove: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const policyRulesSchema = z.array(policyRuleSchema).max(200);

export const policyDraftInputSchema = z
  .object({
    rules: policyRulesSchema,
    note: z.string().min(1).max(500),
    /** The draft version being replaced, or null to open a new draft. Stops two founders overwriting each other. */
    expectedDraftVersion: z.number().int().positive().nullable(),
  })
  .strict();
export type PolicyDraftInput = z.infer<typeof policyDraftInputSchema>;

export const policyPublishInputSchema = z.object({ version: z.number().int().positive() }).strict();
export const policyValidateInputSchema = z.object({ rules: policyRulesSchema }).strict();
export const policyListInputSchema = z.object({ limit: z.number().int().min(1).max(200).default(50) }).strict();

export const policySimulateInputSchema = z
  .object({
    /** Omitted: the published version. */
    version: z.number().int().positive().optional(),
    userId: z.string().min(1).max(200),
    assetId: z.string().min(1).max(200),
    amount: z.string().min(1).max(80),
    network: z.string().min(1).max(200),
    destinationKind: z.string().min(1).max(200),
    destinationRef: z.string().min(1).max(500),
    txType: z.enum(POLICY_TX_TYPES),
  })
  .strict();
export type PolicySimulateInput = z.infer<typeof policySimulateInputSchema>;

export const policyProblemSchema = z.object({ ruleId: z.string().nullable(), problem: z.string() });
export const policyValidationViewSchema = z.object({ valid: z.boolean(), problems: z.array(policyProblemSchema) });

export const policyVersionViewSchema = z.object({
  version: z.number().int(),
  status: z.enum(['draft', 'published', 'superseded']),
  rules: z.array(z.unknown()),
  note: z.string(),
  editedBy: z.string(),
  editedAt: z.string(),
  publishedBy: z.string().nullable(),
  publishedAt: z.string().nullable(),
});
export type PolicyVersionView = z.infer<typeof policyVersionViewSchema>;

export const policyDecisionViewSchema = z.object({
  version: z.number().int(),
  outcome: z.enum(['block', 'approve', 'additional_signers', 'allow', 'no_match']),
  ruleId: z.string().nullable(),
  matchedRuleIds: z.array(z.string()),
  approval: z.object({ members: z.array(z.string()), threshold: z.number().int(), initiatorMayApprove: z.boolean() }).nullable(),
});
export type PolicyDecisionView = z.infer<typeof policyDecisionViewSchema>;
