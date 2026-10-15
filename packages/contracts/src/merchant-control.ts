import { z } from 'zod';

/**
 * MERCHANT CONTROL ROOM — wire contract (workstream W0, built by W1).
 *
 * Shapes only. Nothing here decides a tier name, a cap, a fee, a spread or a
 * reserve rate: those numbers belong to Nitro and Phantom and none are agreed.
 * Every field that holds one is therefore either supplied by an operator or
 * absent (`null`), and absent means REFUSE, never a default.
 *
 * Money is a DECIMAL STRING on the wire (never a JSON number); basis points are
 * integers. In memory the owner converts to scaled bigint via ledger-client.
 */

/** Unsigned decimal string, at most 18 places. The same rule svc-pay's router applies. */
export const payAmountStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');
export type PayAmountString = z.infer<typeof payAmountStringSchema>;

/** Asset code as the ledger names it (`USD`, `USDT`, ...). Opaque to this contract. */
export const payAssetCodeSchema = z.string().min(1).max(16);

export const payMerchantIdSchema = z.string().uuid();
export const payRequestIdSchema = z.string().uuid();
export const payTimestampSchema = z.string().datetime({ offset: true });
/** Optimistic-concurrency token; a decimal counter carried as a string. */
export const payVersionSchema = z
  .string()
  .max(40)
  .regex(/^(?:0|[1-9]\d*)$/);
export const payReasonSchema = z.string().trim().min(3).max(500);
/** Basis points, 0..10000. Never a fraction of a unit. */
export const payBpsSchema = z.number().int().min(0).max(10_000);

/**
 * A tier or archetype id is an OPAQUE slug. The set of valid ids is configuration
 * an operator creates; this contract deliberately does not enumerate "starter /
 * growth / enterprise" because no such names have been agreed.
 */
export const payRiskTierIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/, 'tier ids are lowercase slugs');
export type PayRiskTierId = z.infer<typeof payRiskTierIdSchema>;
export const payMerchantArchetypeIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/, 'archetype ids are lowercase slugs');

/** What a cap limits. Money caps carry a decimal string, the beneficiary cap a count. */
export const PAY_CAP_KINDS = ['per_payment', 'daily_intake', 'monthly_intake', 'daily_payout', 'beneficiaries_per_day'] as const;
export type PayCapKind = (typeof PAY_CAP_KINDS)[number];
export const payCapKindSchema = z.enum(PAY_CAP_KINDS);

export const payMoneyCapSchema = z
  .object({
    kind: z.enum(['per_payment', 'daily_intake', 'monthly_intake', 'daily_payout']),
    assetCode: payAssetCodeSchema,
    limit: payAmountStringSchema,
  })
  .strict();
export const payCountCapSchema = z
  .object({ kind: z.literal('beneficiaries_per_day'), limit: z.number().int().min(0).max(1_000_000) })
  .strict();
export const payCapSchema = z.union([payMoneyCapSchema, payCountCapSchema]);
export type PayCap = z.infer<typeof payCapSchema>;

/** Who keeps the fractional minor unit when a fee does not divide evenly. Recorded on every snapshot. */
export const payRoundingBeneficiarySchema = z.enum(['platform', 'merchant']);

/** One pricing band. `fromAmount` is inclusive; bands are ordered ascending and non-overlapping. */
export const payPricingBandSchema = z
  .object({
    fromAmount: payAmountStringSchema,
    feeBps: payBpsSchema,
    flatFee: payAmountStringSchema.nullable(),
  })
  .strict();
export const PAY_PRICING_LAYERS = ['global', 'tier', 'merchant'] as const;
export const payPricingLayerSchema = z.enum(PAY_PRICING_LAYERS);

export const payPricingRuleSchema = z
  .object({
    layer: payPricingLayerSchema,
    /** Tier id for `tier`, merchant id for `merchant`, null for `global`. */
    scopeId: z.string().min(1).max(64).nullable(),
    assetCode: payAssetCodeSchema,
    bands: z.array(payPricingBandSchema).min(1).max(64),
    /** Conversion spread, applied on USD to USDT only. Null = no spread configured. */
    spreadBps: payBpsSchema.nullable(),
    roundingBeneficiary: payRoundingBeneficiarySchema,
  })
  .strict();
export type PayPricingRule = z.infer<typeof payPricingRuleSchema>;

/** Frozen onto each payment and settlement so a later rule change cannot rewrite history. */
export const payPricingSnapshotSchema = z
  .object({
    snapshotId: z.string().uuid(),
    appliedLayer: payPricingLayerSchema,
    rule: payPricingRuleSchema,
    feeBps: payBpsSchema,
    flatFee: payAmountStringSchema.nullable(),
    spreadBps: payBpsSchema.nullable(),
    roundingBeneficiary: payRoundingBeneficiarySchema,
    capturedAt: payTimestampSchema,
  })
  .strict();
export type PayPricingSnapshot = z.infer<typeof payPricingSnapshotSchema>;

export const payReserveSchema = z
  .object({
    /** Rolling reserve withheld from settlement. Null = none configured for this merchant. */
    rollingReserveBps: payBpsSchema.nullable(),
    holdDays: z.number().int().min(0).max(365).nullable(),
  })
  .strict();

/** What a merchant (or operator drill-down) reads. A null section is unconfigured and refuses money movement. */
export const merchantControlProfileSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    tierId: payRiskTierIdSchema.nullable(),
    archetypeId: payMerchantArchetypeIdSchema.nullable(),
    caps: z.array(payCapSchema).max(32).nullable(),
    pricing: z.array(payPricingRuleSchema).max(32).nullable(),
    reserve: payReserveSchema.nullable(),
    version: payVersionSchema,
    updatedAt: payTimestampSchema.nullable(),
  })
  .strict();
export type MerchantControlProfile = z.infer<typeof merchantControlProfileSchema>;

export const merchantControlGetInputSchema = z.object({ merchantId: payMerchantIdSchema }).strict();

/** An operator change request. The actor comes from authentication, never this body. */
export const merchantControlChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set_tier'), tierId: payRiskTierIdSchema, archetypeId: payMerchantArchetypeIdSchema.nullable() }).strict(),
  z.object({ kind: z.literal('set_caps'), caps: z.array(payCapSchema).min(1).max(32) }).strict(),
  z.object({ kind: z.literal('set_pricing'), pricing: z.array(payPricingRuleSchema).min(1).max(32) }).strict(),
  z.object({ kind: z.literal('set_reserve'), reserve: payReserveSchema }).strict(),
]);
export type MerchantControlChange = z.infer<typeof merchantControlChangeSchema>;

export const merchantControlChangeInputSchema = z
  .object({
    requestId: payRequestIdSchema,
    merchantId: payMerchantIdSchema,
    change: merchantControlChangeSchema,
    reason: payReasonSchema,
    expectedVersion: payVersionSchema,
  })
  .strict();
export type MerchantControlChangeInput = z.infer<typeof merchantControlChangeInputSchema>;

/** Attributed result; a refused or conflicting attempt is audited too and never claims a change. */
export const merchantControlChangeResultSchema = z
  .object({
    requestId: payRequestIdSchema,
    merchantId: payMerchantIdSchema,
    outcome: z.enum(['changed', 'noop', 'refused', 'conflict', 'pending_second_approval']),
    actorUserId: z.string().uuid(),
    profile: merchantControlProfileSchema.nullable(),
    occurredAt: payTimestampSchema,
  })
  .strict();
export type MerchantControlChangeResult = z.infer<typeof merchantControlChangeResultSchema>;

/** Maker-checker on payouts, at merchant-team level. */
export const PAY_PAYOUT_APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'voided', 'expired', 'consumed'] as const;
export const payPayoutApprovalStatusSchema = z.enum(PAY_PAYOUT_APPROVAL_STATUSES);

export const payoutApprovalSchema = z
  .object({
    approvalId: z.string().uuid(),
    merchantId: payMerchantIdSchema,
    settlementId: z.string().uuid(),
    amount: payAmountStringSchema,
    assetCode: payAssetCodeSchema,
    /** Hash over amount + destination + rail. A change after request voids the approval. */
    payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    status: payPayoutApprovalStatusSchema,
    makerUserId: z.string().uuid(),
    checkerUserId: z.string().uuid().nullable(),
    createdAt: payTimestampSchema,
    decidedAt: payTimestampSchema.nullable(),
    expiresAt: payTimestampSchema,
  })
  .strict();
export type PayoutApproval = z.infer<typeof payoutApprovalSchema>;

export const merchantControlApprovalListInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    status: payPayoutApprovalStatusSchema.optional(),
    limit: z.number().int().min(1).max(200),
  })
  .strict();

export const merchantControlApprovalDecideInputSchema = z
  .object({
    approvalId: z.string().uuid(),
    decision: z.enum(['approve', 'reject']),
    /** The checker confirms the exact payload they reviewed. */
    expectedPayloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    reason: payReasonSchema,
  })
  .strict();
