import { z } from 'zod';
import {
  payAmountStringSchema,
  payAssetCodeSchema,
  payMerchantIdSchema,
  payRequestIdSchema,
  payTimestampSchema,
} from './merchant-control.js';

/**
 * USD to USDT CONVERSION — wire contract (workstream W0, built by W6).
 *
 * Sandbox only: the first build is hard-wired to a venue testnet and live mode
 * refuses to boot, so every view carries `mode: 'sandbox'`. No rate, spread or
 * fee is defined here; a quote carries the numbers the venue and the pricing
 * rules produced, as decimal strings.
 */

export const payConversionModeSchema = z.literal('sandbox');

export const PAY_CONVERSION_STATUSES = [
  'quoted',
  'intent_committed',
  'placing',
  'placed',
  'partially_filled',
  'filled',
  'failed',
  'reversed',
  'expired',
] as const;
export const payConversionStatusSchema = z.enum(PAY_CONVERSION_STATUSES);
export type PayConversionStatus = (typeof PAY_CONVERSION_STATUSES)[number];

export const conversionQuoteInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    settlementId: z.string().guid(),
    fromAsset: payAssetCodeSchema,
    toAsset: payAssetCodeSchema,
    fromAmount: payAmountStringSchema,
  })
  .strict();
export type ConversionQuoteInput = z.infer<typeof conversionQuoteInputSchema>;

export const conversionQuoteSchema = z
  .object({
    quoteId: z.string().guid(),
    mode: payConversionModeSchema,
    merchantId: payMerchantIdSchema,
    settlementId: z.string().guid(),
    fromAsset: payAssetCodeSchema,
    toAsset: payAssetCodeSchema,
    fromAmount: payAmountStringSchema,
    /** Units of `toAsset` per one unit of `fromAsset`, as the venue quoted it. */
    rate: payAmountStringSchema,
    feeAmount: payAmountStringSchema,
    spreadAmount: payAmountStringSchema,
    /** Gross to-asset the limit price protects. A fill still under this is inventory, not erased. */
    minimumOutput: payAmountStringSchema,
    expectedOutput: payAmountStringSchema,
    expiresAt: payTimestampSchema,
  })
  .strict();
export type ConversionQuote = z.infer<typeof conversionQuoteSchema>;

export const conversionExecuteInputSchema = z
  .object({
    /** Retrying the same id never places a second venue order. */
    requestId: payRequestIdSchema,
    quoteId: z.string().guid(),
  })
  .strict();

export const conversionOrderSchema = z
  .object({
    conversionId: z.string().guid(),
    requestId: payRequestIdSchema,
    mode: payConversionModeSchema,
    merchantId: payMerchantIdSchema,
    settlementId: z.string().guid(),
    status: payConversionStatusSchema,
    fromAsset: payAssetCodeSchema,
    toAsset: payAssetCodeSchema,
    fromAmount: payAmountStringSchema,
    filledFromAmount: payAmountStringSchema,
    filledToAmount: payAmountStringSchema,
    failureCode: z.string().nullable(),
    createdAt: payTimestampSchema,
    updatedAt: payTimestampSchema,
  })
  .strict();
export type ConversionOrder = z.infer<typeof conversionOrderSchema>;

const conversionChangeHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** First founder. The body names the row, not a fill. */
export const conversionResolveProposeInputSchema = z
  .object({
    requestId: payRequestIdSchema,
    conversionId: z.string().guid(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const conversionResolveProposeResultSchema = z
  .object({
    requestId: payRequestIdSchema,
    status: z.enum(['pending', 'missing', 'not_placing', 'conflict']),
    changeHash: conversionChangeHashSchema.nullable(),
  })
  .strict();

/** Second founder. `expectedChangeHash` is the hash from the proposal. No amounts. */
export const conversionResolveConfirmInputSchema = z
  .object({
    requestId: payRequestIdSchema,
    decision: z.enum(['confirm', 'reject']),
    reason: z.string().trim().min(1).max(500),
    expectedChangeHash: conversionChangeHashSchema,
  })
  .strict();

export const conversionResolveConfirmResultSchema = z
  .object({
    requestId: payRequestIdSchema,
    status: z.enum(['confirmed', 'rejected', 'missing', 'hash_mismatch', 'same_founder', 'not_placing']),
    changeHash: conversionChangeHashSchema.nullable(),
    order: conversionOrderSchema.nullable(),
  })
  .strict();

/** First founder. The body names the late-fill audit and how it was settled. No amounts. */
export const conversionLateFillProposeInputSchema = z
  .object({
    requestId: payRequestIdSchema,
    auditId: z.string().guid(),
    /** How the late fill was settled. A sentence, not a quantity. */
    settlement: z.string().trim().min(1).max(500),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const conversionLateFillProposeResultSchema = z
  .object({
    requestId: payRequestIdSchema,
    status: z.enum(['pending', 'missing', 'conflict', 'already_acked']),
    changeHash: conversionChangeHashSchema.nullable(),
  })
  .strict();

/** Second founder. Same body as a resolve confirm. `settlement` is what was recorded. */
export const conversionLateFillConfirmResultSchema = z
  .object({
    requestId: payRequestIdSchema,
    status: z.enum(['confirmed', 'rejected', 'missing', 'hash_mismatch', 'same_founder', 'not_pending']),
    changeHash: conversionChangeHashSchema.nullable(),
    settlement: z.string().nullable(),
  })
  .strict();

/** First founder. Names the late-fill audit. No amount, no venue numbers. */
export const conversionLateFillBookProposeInputSchema = z
  .object({
    requestId: payRequestIdSchema,
    auditId: z.string().guid(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const conversionLateFillBookProposeResultSchema = z
  .object({
    requestId: payRequestIdSchema,
    status: z.enum(['pending', 'missing', 'conflict', 'already_booked', 'absent', 'below_minimum', 'not_bookable']),
    changeHash: conversionChangeHashSchema.nullable(),
  })
  .strict();

/** Second founder. Same body as a resolve confirm. `funding` is which pot paid the USD. */
export const conversionLateFillBookConfirmResultSchema = z
  .object({
    requestId: payRequestIdSchema,
    status: z.enum([
      'confirmed',
      'rejected',
      'missing',
      'hash_mismatch',
      'same_founder',
      'not_pending',
      'evidence_changed',
      'below_minimum',
      'already_booked',
    ]),
    changeHash: conversionChangeHashSchema.nullable(),
    funding: z.enum(['merchant', 'inventory']).nullable(),
    order: conversionOrderSchema.nullable(),
  })
  .strict();

export const conversionLateFillSweepResultSchema = z
  .object({
    checked: z.number().int().nonnegative(),
    found: z.number().int().nonnegative(),
    finalized: z.number().int().nonnegative(),
    busy: z.boolean(),
    errors: z
      .array(
        z
          .object({
            conversionId: z.string().guid(),
            code: z.string().min(1),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export const conversionHoldSweepResultSchema = z
  .object({
    released: z.number().int().nonnegative(),
    busy: z.boolean(),
    failures: z
      .array(
        z
          .object({
            conversionId: z.string().min(1),
            code: z.string().min(1),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export const conversionGetInputSchema = z.object({ conversionId: z.string().guid() }).strict();
export const conversionListInputSchema = z
  .object({ merchantId: payMerchantIdSchema, status: payConversionStatusSchema.optional(), limit: z.number().int().min(1).max(200) })
  .strict();
