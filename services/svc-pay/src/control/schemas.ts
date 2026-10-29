import { z } from 'zod';
import {
  payAmountStringSchema,
  payAssetCodeSchema,
  payCapSchema,
  payMerchantIdSchema,
  payPricingRuleSchema,
  payReasonSchema,
  payReserveSchema,
  payRequestIdSchema,
  payRiskTierIdSchema,
  payTimestampSchema,
  payVersionSchema,
  payoutApprovalSchema,
  payBpsSchema,
  payPayoutFeeSchema,
} from '@intafaced/contracts';

/**
 * Wire shapes W1 needs beyond packages/contracts/src/merchant-control.ts.
 * They live here, not in the contract package, because W1 does not own that
 * package; hoist them there when the apps start importing them.
 *
 * Money is a decimal string. No schema here carries a default number.
 */

export const ARCHETYPES = ['psp', 'broker', 'gaming', 'standard'] as const;
export const archetypeSchema = z.enum(ARCHETYPES);

/** The contract's rule plus the optional min/max fee the contract does not carry. */
export const controlPricingRuleSchema = payPricingRuleSchema
  .extend({ minFee: payAmountStringSchema.nullable().optional(), maxFee: payAmountStringSchema.nullable().optional() })
  .strict();
export type ControlPricingRuleInput = z.infer<typeof controlPricingRuleSchema>;

/** A rule's content without its layer and scope: those come from where it is submitted. */
export const pricingRuleBodySchema = payPricingRuleSchema
  .omit({ layer: true, scopeId: true })
  .extend({ minFee: payAmountStringSchema.nullable().optional(), maxFee: payAmountStringSchema.nullable().optional() })
  .strict();
export type PricingRuleBody = z.infer<typeof pricingRuleBodySchema>;

const thresholdSchema = z.object({ assetCode: payAssetCodeSchema, amount: payAmountStringSchema }).strict();

export const tierDefinitionSchema = z
  .object({
    id: payRiskTierIdSchema,
    name: z.string().trim().min(1).max(64),
    archetype: archetypeSchema,
    caps: z.array(payCapSchema).min(1).max(32),
    /** Null = this tier holds no rolling reserve. */
    reserve: payReserveSchema.nullable(),
    /** Payouts at or above this amount, per asset, need a second team member. */
    approvalThresholds: z.array(thresholdSchema).min(1).max(32),
    /** Payouts at or above this amount, per asset, also need two distinct founders. */
    founderThresholds: z.array(thresholdSchema).min(1).max(32),
    /** How long an approval request stays valid. Bounds are validation, not defaults. */
    approvalTtlSeconds: z.number().int().min(60).max(2_592_000),
    /**
     * When true, every merchant may read this tier's commercial terms.
     * Omitted means false: the tier stays off the ladder except for the merchant
     * it is assigned to.
     */
    merchantVisible: z.boolean().optional(),
    /**
     * The payout fee the tier publishes to merchants. Omitted or null means none
     * is published, and merchants read "Not set". `not_charged` is the only kind,
     * because payouts charge no fee (payment-service/payouts.ts).
     */
    payoutFee: payPayoutFeeSchema.nullable().optional(),
  })
  .strict();
export type TierDefinitionInput = z.infer<typeof tierDefinitionSchema>;

/** Operator changes beyond the contract's merchant kinds: tier definitions and pricing layers. */
export const controlConfigureChangeSchema = z.discriminatedUnion('kind', [
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

export const tierViewSchema = tierDefinitionSchema
  .extend({
    version: payVersionSchema,
    merchants: z.number().int().min(0),
    merchantVisible: z.boolean(),
    payoutFee: payPayoutFeeSchema.nullable(),
  })
  .strict();
export const tierListInputSchema = z.object({}).strict();

export const pricingRuleViewSchema = controlPricingRuleSchema
  .extend({ ruleId: z.string().guid(), version: payVersionSchema, createdAt: payTimestampSchema })
  .strict();
export const pricingRuleListInputSchema = z
  .object({ layer: z.enum(['global', 'tier', 'merchant']).optional(), scopeId: z.string().min(1).max(64).optional() })
  .strict();

// ── merchant-facing extras ──────────────────────────────────────────────────

export const pricingPreviewInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    assetCode: payAssetCodeSchema,
    amount: payAmountStringSchema,
    /** Volume already done this month, to pick the band. Omit to use the merchant's real month-to-date. */
    monthlyVolume: payAmountStringSchema.optional(),
    /** USD to USDT conversion: includes the spread. */
    conversion: z.boolean().optional(),
  })
  .strict();

export const pricingQuoteSchema = z
  .object({
    ruleId: z.string().guid(),
    appliedLayer: z.enum(['global', 'tier', 'merchant']),
    ruleChain: z.array(
      z.object({ layer: z.enum(['global', 'tier', 'merchant']), ruleId: z.string().guid(), version: payVersionSchema }).strict(),
    ),
    monthlyVolumeBefore: payAmountStringSchema,
    bandFrom: payAmountStringSchema,
    feeBps: payBpsSchema,
    flatFee: payAmountStringSchema.nullable(),
    spreadBps: payBpsSchema.nullable(),
    roundingBeneficiary: z.enum(['platform', 'merchant']),
    roundingMode: z.enum(['ceil', 'floor']),
    bpsFee: payAmountStringSchema,
    feeBeforeClamp: payAmountStringSchema,
    fee: payAmountStringSchema,
    spread: payAmountStringSchema.nullable(),
    net: z.string().regex(/^-?\d+(\.\d{1,18})?$/),
  })
  .strict();
export type PricingQuoteView = z.infer<typeof pricingQuoteSchema>;

export const usageInputSchema = z.object({ merchantId: payMerchantIdSchema }).strict();
export const usageViewSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    tierId: payRiskTierIdSchema.nullable(),
    asOf: payTimestampSchema,
    rows: z.array(
      z
        .object({
          kind: z.enum(['per_payment', 'daily_intake', 'monthly_intake', 'daily_payout', 'beneficiaries_per_day']),
          assetCode: payAssetCodeSchema.nullable(),
          limit: z.string(),
          used: z.string().nullable(),
          remaining: z.string().nullable(),
          resetsAt: payTimestampSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const approvalRequestInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    settlementId: z.string().guid(),
    railId: z.string().min(1).max(64),
  })
  .strict();
export const approvalCancelInputSchema = z.object({ approvalId: z.string().guid(), reason: payReasonSchema }).strict();

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
