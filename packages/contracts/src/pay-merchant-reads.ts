import { z } from 'zod';
import { payAmountStringSchema, payAssetCodeSchema, payBpsSchema, payMerchantIdSchema, payTimestampSchema } from './merchant-control.js';

/**
 * Merchant payment and settlement reads (W2c).
 *
 * Money stays a decimal string. A missing pricing snapshot is `null`: the read
 * returns the row that was stored when the fee was decided, and never a fee
 * recomputed from today's rules. A failure is a catalog code plus a fixed
 * sentence. It is not a rail payload, a stack, or a free-text provider reason.
 */

export const payListCursorSchema = z.string().min(1).max(300);
export const payListSearchSchema = z.string().trim().min(1).max(200);

const paymentStatusSchema = z.enum(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']);
const settlementStatusSchema = z.enum(['pending', 'posted', 'paid_out', 'failed']);

/** Page size stays optional so an omitted limit still refuses in the service. Blank is not a default page. */
const pageLimitSchema = z.number().int().min(1).max(200).optional();

export const payPaymentListInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    status: paymentStatusSchema.optional(),
    limit: pageLimitSchema,
    cursor: payListCursorSchema.optional(),
    search: payListSearchSchema.optional(),
    assetId: payAssetCodeSchema.optional(),
    from: payTimestampSchema.optional(),
    to: payTimestampSchema.optional(),
    /**
     * Payments opened through this payment link. A link that is missing or
     * belongs to another merchant is an empty page, not an error.
     */
    linkId: z.string().guid().optional(),
    /**
     * Inclusive amount bounds, decimal strings. Omitted means no bound.
     * A blank string is not "no bound": the service refuses it.
     */
    amountMin: z.string().optional(),
    amountMax: z.string().optional(),
  })
  .strict();

/**
 * Totals for the filter, not the loaded page. Counts are decimal integer
 * strings. `successRate` is a whole percent, half up, or null when nothing
 * in the filter has finished.
 */
export const payPaymentListSummarySchema = z
  .object({
    matchedCount: z.string().regex(/^(?:0|[1-9]\d*)$/),
    succeededCount: z.string().regex(/^(?:0|[1-9]\d*)$/),
    failedCount: z.string().regex(/^(?:0|[1-9]\d*)$/),
    finishedCount: z.string().regex(/^(?:0|[1-9]\d*)$/),
    successRate: z
      .string()
      .regex(/^(?:100|[1-9]?\d)$/)
      .nullable(),
  })
  .strict();

/** One rail try on a payment. `mapsTo` is the status that try means before capture. */
export const payPaymentAttemptSchema = z
  .object({
    id: z.string().guid(),
    at: payTimestampSchema,
    status: z.enum(['pending', 'authorized', 'failed']),
    railRef: z.string().nullable(),
    mapsTo: z.enum(['created', 'authorized', 'failed']),
  })
  .strict();

/** While an open crypto payment waits for its transfers to be final: how deep, how deep it must be, and as of when. */
export const payPaymentConfirmationsSchema = z
  .object({ seen: z.number().int().min(0), required: z.number().int().min(1), asOf: payTimestampSchema })
  .strict();

export const paySettlementListInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    status: settlementStatusSchema.optional(),
    limit: pageLimitSchema,
    cursor: payListCursorSchema.optional(),
    search: payListSearchSchema.optional(),
    assetId: payAssetCodeSchema.optional(),
    from: payTimestampSchema.optional(),
    to: payTimestampSchema.optional(),
  })
  .strict();

export const paySettlementLinesInputSchema = z
  .object({
    settlementId: z.string().guid(),
    limit: pageLimitSchema,
    cursor: payListCursorSchema.optional(),
  })
  .strict();

export const payMerchantFailureSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9._]{0,63}$/),
    message: z.string().min(1).max(200),
  })
  .strict();
export type PayMerchantFailure = z.infer<typeof payMerchantFailureSchema>;

/**
 * The pricing row written when the fee was decided. `fee` is that stored
 * amount. `null` on the parent means no row was stored (older payments, or a
 * payment taken while pricing was not configured).
 */
export const payRecordedPricingSnapshotSchema = z
  .object({
    fee: payAmountStringSchema,
    assetCode: payAssetCodeSchema,
    appliedLayer: z.enum(['global', 'tier', 'merchant']),
    ruleId: z.string().guid(),
    feeBps: payBpsSchema,
    flatFee: payAmountStringSchema.nullable(),
    spreadBps: payBpsSchema.nullable(),
    roundingBeneficiary: z.enum(['platform', 'merchant']),
    roundingMode: z.enum(['ceil', 'floor']),
    bookedFee: payAmountStringSchema.nullable(),
    reserveAmount: payAmountStringSchema.nullable(),
    recordedAt: payTimestampSchema,
  })
  .strict();
export type PayRecordedPricingSnapshot = z.infer<typeof payRecordedPricingSnapshotSchema>;

/**
 * Viewer and developer reads. The fee that was charged, and nothing about which
 * rule, spread, or layer produced it.
 */
export const payFeeOnlySnapshotSchema = z.object({ fee: payAmountStringSchema }).strict();

/** Full snapshot for owner, admin, and finance. Fee only for viewer and developer. */
export const payPricingSnapshotViewSchema = z.union([payRecordedPricingSnapshotSchema, payFeeOnlySnapshotSchema]);

export const paySettlementLineSchema = z
  .object({
    paymentId: z.string().guid(),
    /**
     * Net included at freeze (captured minus refunded). Null when the
     * `settlement.included` event predates that field — never the payment's
     * face amount, which does not sum to the settlement gross.
     */
    amount: payAmountStringSchema.nullable(),
    assetId: payAssetCodeSchema,
    createdAt: payTimestampSchema,
    /** False when `amount` was not stored on the freeze event. */
    includedAmountKnown: z.boolean(),
  })
  .strict();
export type PaySettlementLine = z.infer<typeof paySettlementLineSchema>;

export function payPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() }).strict();
}
