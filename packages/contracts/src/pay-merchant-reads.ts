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
  })
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
    settlementId: z.string().uuid(),
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
    ruleId: z.string().uuid(),
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

export const paySettlementLineSchema = z
  .object({
    paymentId: z.string().uuid(),
    amount: payAmountStringSchema,
    assetId: payAssetCodeSchema,
    createdAt: payTimestampSchema,
  })
  .strict();
export type PaySettlementLine = z.infer<typeof paySettlementLineSchema>;

export function payPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() }).strict();
}
