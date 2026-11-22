import { z } from 'zod';
import {
  payAmountStringSchema,
  payPricingRuleSchema,
  payReasonSchema,
  payRequestIdSchema,
  payTimestampSchema,
  payVersionSchema,
  payoutApprovalSchema,
} from '@intafaced/contracts/merchant-control';
import { tierDefinitionSchema, controlPricingRuleSchema } from '@intafaced/contracts/pay-founder-admin-procedures';
import {
  usageInputSchema,
  pricingPreviewInputSchema,
  approvalCancelInputSchema,
  approvalRequestInputSchema,
} from '@intafaced/contracts/pay-call-schemas';

export type ControlPricingRuleInput = z.infer<typeof controlPricingRuleSchema>;

/** A rule's content without its layer and scope: those come from where it is submitted. */
export const pricingRuleBodySchema = payPricingRuleSchema
  .omit({ layer: true, scopeId: true })
  .extend({ minFee: payAmountStringSchema.nullable().optional(), maxFee: payAmountStringSchema.nullable().optional() })
  .strict();
export type PricingRuleBody = z.infer<typeof pricingRuleBodySchema>;

export type TierDefinitionInput = z.infer<typeof tierDefinitionSchema>;

/** Operator changes beyond the contract's merchant kinds: tier definitions and pricing layers. */
const controlConfigureChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upsert_tier'), tier: tierDefinitionSchema }).strict(),
  z
    .object({
      kind: z.literal('set_pricing_layer'),
      layer: z.enum(['global', 'tier', 'merchant']),
      /** Tier id for `tier`, merchant id for `merchant`, absent for `global`. */
      scopeId: z.string().min(1).max(64).nullable(),
      rules: z.array(pricingRuleBodySchema).min(1).max(32),
    })
    .strict(),
]);
export type ControlConfigureChange = z.infer<typeof controlConfigureChangeSchema>;

export const controlConfigureInputSchema = z
  .object({
    requestId: payRequestIdSchema,
    change: controlConfigureChangeSchema,
    reason: payReasonSchema,
    expectedVersion: payVersionSchema,
  })
  .strict();

export const controlConfigureResultSchema = z
  .object({
    requestId: payRequestIdSchema,
    scope: z.enum(['tier', 'pricing']),
    scopeId: z.string(),
    outcome: z.enum(['changed', 'noop', 'refused', 'conflict', 'pending_second_approval']),
    actorUserId: z.string().min(1),
    version: payVersionSchema,
    occurredAt: payTimestampSchema,
  })
  .strict();
export type ControlConfigureResult = z.infer<typeof controlConfigureResultSchema>;

// ── merchant-facing extras ──────────────────────────────────────────────────

/** A founder decision on an above-founder-threshold payout; the first and the second founder both call this. */
export const founderApprovalDecideInputSchema = z
  .object({
    approvalId: z.string().guid(),
    decision: z.enum(['approve', 'reject']),
    expectedPayloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    reason: payReasonSchema,
  })
  .strict();

export { payoutApprovalSchema };
export { tierDefinitionSchema };
