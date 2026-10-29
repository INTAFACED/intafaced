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

export const payMerchantIdSchema = z.string().guid();
export const payRequestIdSchema = z.string().guid();
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
    snapshotId: z.string().guid(),
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

/**
 * Founder-desk label while packages/ledger-client has no merchant rolling-reserve
 * recipe. The percentage may still be stored on a tier or an old profile row.
 * It is not money held on the ledger.
 */
export const PAY_RESERVE_NOT_ENFORCED = 'not enforced: reserve ledger unwired' as const;

/** Read shape. `enforcement` is present only when a percentage is configured. Writes stay on `payReserveSchema`. */
export const payReserveViewSchema = payReserveSchema
  .extend({
    enforcement: z.literal(PAY_RESERVE_NOT_ENFORCED).optional(),
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
    reserve: payReserveViewSchema.nullable(),
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
    actorUserId: z.string().guid(),
    profile: merchantControlProfileSchema.nullable(),
    occurredAt: payTimestampSchema,
  })
  .strict();
export type MerchantControlChangeResult = z.infer<typeof merchantControlChangeResultSchema>;

/** Maker-checker on payouts, at merchant-team level. */
export const PAY_PAYOUT_APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'voided', 'expired', 'consumed'] as const;
export const payPayoutApprovalStatusSchema = z.enum(PAY_PAYOUT_APPROVAL_STATUSES);

/**
 * A payout destination safe to put on an approval list. The full account or address
 * stays in the database; this is last-4 (`••••1234`) or first6…last4 (`0x1234…abcd`).
 * Short enough that a full IBAN or chain address cannot pass this field.
 */
export const payMaskedDestinationSchema = z.string().min(1).max(16);
export const payRailIdSchema = z.string().min(1).max(64);
export const payDestinationKindSchema = z.string().min(1).max(32);

export const payoutApprovalSchema = z
  .object({
    approvalId: z.string().guid(),
    merchantId: payMerchantIdSchema,
    settlementId: z.string().guid(),
    amount: payAmountStringSchema,
    assetCode: payAssetCodeSchema,
    /** Hash over amount + destination + rail. A change after request voids the approval. */
    payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    status: payPayoutApprovalStatusSchema,
    makerUserId: z.string().guid(),
    checkerUserId: z.string().guid().nullable(),
    createdAt: payTimestampSchema,
    decidedAt: payTimestampSchema.nullable(),
    expiresAt: payTimestampSchema,
    /** Rail the payout would use, from the stored approval payload. */
    railId: payRailIdSchema,
    /** Destination kind label (`crypto`, `bank`). Not the account or address. */
    destinationKind: payDestinationKindSchema,
    /** Masked destination. Never the full account number or address. */
    destinationMasked: payMaskedDestinationSchema,
  })
  .strict();
export type PayoutApproval = z.infer<typeof payoutApprovalSchema>;

export const merchantControlApprovalListInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    status: payPayoutApprovalStatusSchema.optional(),
    limit: z.number().int().min(1).max(200),
    cursor: z.string().min(1).max(300).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

/**
 * Headroom still approvable today for one asset. `remaining` is an exact decimal
 * string. Null means no daily payout limit is configured: approval refuses.
 */
export const dailyPayoutRemainingSchema = z
  .object({
    assetCode: payAssetCodeSchema,
    remaining: payAmountStringSchema.nullable(),
  })
  .strict();

export const merchantControlApprovalPageSchema = z
  .object({
    items: z.array(payoutApprovalSchema),
    nextCursor: z.string().nullable(),
    dailyPayoutRemaining: z.array(dailyPayoutRemainingSchema).max(232),
  })
  .strict();

export const merchantControlApprovalDecideInputSchema = z
  .object({
    approvalId: z.string().guid(),
    decision: z.enum(['approve', 'reject']),
    /** The checker confirms the exact payload they reviewed. */
    expectedPayloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    reason: payReasonSchema,
  })
  .strict();

/**
 * The fee a tier publishes for a payout. `not_charged` says INTAFACED takes no
 * fee on a payout. Null (on the tier) means the founders have published nothing,
 * which a merchant reads as "Not set", never as free. Only `not_charged` exists:
 * payouts charge no fee today, and a charged kind is added here when one is
 * built, so a published kind is always what the payout path does.
 */
export const payPayoutFeeSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('not_charged') }).strict()]);
export type PayPayoutFee = z.infer<typeof payPayoutFeeSchema>;

/**
 * One processing-fee rule a tier publishes (the tier pricing layer), as a
 * merchant reads it on the ladder. A tier with no rule for an asset has no
 * entry: its fee is blank, and the pricing engine refuses a total from it.
 */
export const merchantTierFeeSchema = z
  .object({
    assetCode: payAssetCodeSchema,
    bands: z.array(payPricingBandSchema).min(1).max(64),
    spreadBps: payBpsSchema.nullable(),
    roundingBeneficiary: payRoundingBeneficiarySchema,
    minFee: payAmountStringSchema.nullable(),
    maxFee: payAmountStringSchema.nullable(),
    version: payVersionSchema,
  })
  .strict();
export type MerchantTierFee = z.infer<typeof merchantTierFeeSchema>;

/**
 * What a merchant may see of a configured tier: the commercial terms (caps,
 * reserve, the tier's own processing fees and its published payout fee).
 * Founder thresholds, approval bars, TTL and how many other merchants sit on
 * the tier are not in this shape.
 */
export const merchantTierSummarySchema = z
  .object({
    id: payRiskTierIdSchema,
    name: z.string().min(1).max(64),
    archetype: z.enum(['psp', 'broker', 'gaming', 'standard']),
    caps: z.array(payCapSchema).min(1).max(32),
    reserve: payReserveSchema.nullable(),
    /** The tier layer's live rules, one per asset. Empty = the tier publishes no processing fee. */
    fees: z.array(merchantTierFeeSchema).max(32),
    /** Null = no payout fee is published for this tier. */
    payoutFee: payPayoutFeeSchema.nullable(),
    version: payVersionSchema,
  })
  .strict();
export type MerchantTierSummary = z.infer<typeof merchantTierSummarySchema>;

export const merchantTierListInputSchema = z.object({ merchantId: payMerchantIdSchema }).strict();
/**
 * `not_configured` means the catalogue has no tier. `configured` is the ladder:
 * every tier's commercial terms, and `ownTierId` for the tier this merchant is
 * on (`null` when none is assigned). Founder thresholds, approval bars, TTL and
 * how many other merchants sit on a tier are not in this shape. 64 is a
 * response-size bound, not a product limit.
 */
const merchantTierConfiguredSchema = z
  .object({
    status: z.literal('configured'),
    ownTierId: payRiskTierIdSchema.nullable(),
    tiers: z.array(merchantTierSummarySchema).min(1).max(64),
  })
  .strict();
export const merchantTierListSchema = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('not_configured'), ownTierId: z.null() }).strict(),
    merchantTierConfiguredSchema,
  ])
  .superRefine((value, ctx) => {
    if (value.status !== 'configured') return;
    const ids = value.tiers.map((tier) => tier.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tier ids must be unique' });
    }
    if (value.ownTierId !== null && !ids.includes(value.ownTierId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'current tier must be one of the listed tiers' });
    }
  });
export type MerchantTierList = z.infer<typeof merchantTierListSchema>;

/** One pricing rule as it was written, including a superseded row, so a later edit cannot hide the old price. */
export const merchantPricingHistoryEventSchema = z
  .object({
    ruleId: z.string().guid(),
    layer: payPricingLayerSchema,
    scopeId: z.string().min(1).max(64).nullable(),
    assetCode: payAssetCodeSchema,
    bands: z.array(payPricingBandSchema).min(1).max(64),
    spreadBps: payBpsSchema.nullable(),
    roundingBeneficiary: payRoundingBeneficiarySchema,
    minFee: payAmountStringSchema.nullable(),
    maxFee: payAmountStringSchema.nullable(),
    version: payVersionSchema,
    createdAt: payTimestampSchema,
    supersededAt: payTimestampSchema.nullable(),
  })
  .strict();
export type MerchantPricingHistoryEvent = z.infer<typeof merchantPricingHistoryEventSchema>;

export const merchantPricingHistoryInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    /** Required. A missing page size is a refusal, never an invented default. */
    limit: z.number().int().min(1).max(200),
  })
  .strict();
export const merchantPricingHistorySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_configured'), events: z.tuple([]) }).strict(),
  z.object({ status: z.literal('configured'), events: z.array(merchantPricingHistoryEventSchema).min(1).max(200) }).strict(),
]);
export type MerchantPricingHistory = z.infer<typeof merchantPricingHistorySchema>;

/**
 * Caps on a limit ask, as a reader may return them.
 * A stored row that still matches a cap is the parsed list.
 * A stored row that does not is `{ raw, capsReadable: false }`: the JSON that
 * was stored, flagged so a client can say "caps unreadable" and a bad row
 * cannot fail the read of every other ask. `raw` is not a cap.
 */
export const merchantLimitCapsSchema = z.union([
  z.array(payCapSchema).min(1).max(32),
  z.object({ raw: z.unknown(), capsReadable: z.literal(false) }).strict(),
]);
export type MerchantLimitCaps = z.infer<typeof merchantLimitCapsSchema>;

/**
 * A merchant's ask for higher caps. Storing it does not change the caps the
 * money path reads. Those still change only through the founder dual-control flow.
 */
export const merchantLimitRequestSchema = z
  .object({
    requestId: payRequestIdSchema,
    merchantId: payMerchantIdSchema,
    caps: merchantLimitCapsSchema,
    reason: payReasonSchema,
    status: z.literal('pending'),
    requestedBy: z.string().min(1).max(128),
    createdAt: payTimestampSchema,
  })
  .strict();
export type MerchantLimitRequest = z.infer<typeof merchantLimitRequestSchema>;

/**
 * Money the merchant is asking for. Above zero, at most 30 integer digits.
 * The general cap schema still allows a stored zero; this ask does not.
 */
const merchantLimitAskAmountSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/)
  .refine((value) => !/^0+(?:\.0+)?$/.test(value), 'limit must be greater than zero');

const merchantLimitAskCapSchema = z.union([
  payMoneyCapSchema.extend({ limit: merchantLimitAskAmountSchema }).strict(),
  z.object({ kind: z.literal('beneficiaries_per_day'), limit: z.number().int().min(1).max(1_000_000) }).strict(),
]);

/** One ask: each kind+asset once. A count cap has no asset, so it may appear once. */
export const merchantLimitAskCapsSchema = z
  .array(merchantLimitAskCapSchema)
  .min(1)
  .max(32)
  .superRefine((caps, ctx) => {
    const seen = new Set<string>();
    for (const cap of caps) {
      const key = cap.kind === 'beneficiaries_per_day' ? cap.kind : `${cap.kind}:${cap.assetCode}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate cap kind and asset' });
        return;
      }
      seen.add(key);
    }
  });

export const merchantLimitIncreaseInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    requestId: payRequestIdSchema,
    caps: merchantLimitAskCapsSchema,
    reason: payReasonSchema,
  })
  .strict();
export const merchantLimitIncreaseResultSchema = merchantLimitRequestSchema
  .extend({ outcome: z.enum(['stored', 'already_open']) })
  .strict();
export type MerchantLimitIncreaseResult = z.infer<typeof merchantLimitIncreaseResultSchema>;

/** The ask after it has left pending. Caps and the original reason are unchanged. */
export const merchantLimitTerminalSchema = z
  .object({
    requestId: payRequestIdSchema,
    merchantId: payMerchantIdSchema,
    caps: merchantLimitCapsSchema,
    reason: payReasonSchema,
    requestedBy: z.string().min(1).max(128),
    createdAt: payTimestampSchema,
    status: z.enum(['withdrawn', 'closed']),
    closedAt: payTimestampSchema,
    closedBy: z.string().min(1).max(128),
    closeReason: payReasonSchema,
  })
  .strict();
export type MerchantLimitTerminal = z.infer<typeof merchantLimitTerminalSchema>;

export const merchantLimitWithdrawInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    requestId: payRequestIdSchema,
    reason: payReasonSchema,
  })
  .strict();
export const merchantLimitWithdrawResultSchema = merchantLimitTerminalSchema.extend({ status: z.literal('withdrawn') }).strict();
export type MerchantLimitWithdrawResult = z.infer<typeof merchantLimitWithdrawResultSchema>;

/**
 * Founder closes one ask. The actor is the session, never this body.
 * Caps are returned as stored. JSON that no longer matches a cap is still a
 * successful close: refusing here would leave the ask open.
 */
export const founderLimitRequestCloseInputSchema = z
  .object({
    requestId: payRequestIdSchema,
    reason: payReasonSchema,
  })
  .strict();
export const founderLimitRequestCloseResultSchema = merchantLimitTerminalSchema
  .omit({ caps: true })
  .extend({
    status: z.literal('closed'),
    caps: z.union([z.array(payCapSchema).min(1).max(32), z.unknown()]),
  })
  .strict();
export type FounderLimitRequestCloseResult = z.infer<typeof founderLimitRequestCloseResultSchema>;

/** The caller's open request, or `none` when they have not asked. `none` is not a cap. */
export const merchantLimitOpenInputSchema = z.object({ merchantId: payMerchantIdSchema }).strict();
export const merchantLimitOpenSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }).strict(),
  z.object({ status: z.literal('pending'), request: merchantLimitRequestSchema }).strict(),
]);
export type MerchantLimitOpen = z.infer<typeof merchantLimitOpenSchema>;

export const founderLimitRequestListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(200),
    cursor: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
  })
  .strict();
export const founderLimitRequestListSchema = z
  .object({
    requests: z.array(merchantLimitRequestSchema).max(200),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type FounderLimitRequestList = z.infer<typeof founderLimitRequestListSchema>;
