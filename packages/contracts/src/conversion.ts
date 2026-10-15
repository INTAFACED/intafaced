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
    settlementId: z.string().uuid(),
    fromAsset: payAssetCodeSchema,
    toAsset: payAssetCodeSchema,
    fromAmount: payAmountStringSchema,
  })
  .strict();
export type ConversionQuoteInput = z.infer<typeof conversionQuoteInputSchema>;

export const conversionQuoteSchema = z
  .object({
    quoteId: z.string().uuid(),
    mode: payConversionModeSchema,
    merchantId: payMerchantIdSchema,
    settlementId: z.string().uuid(),
    fromAsset: payAssetCodeSchema,
    toAsset: payAssetCodeSchema,
    fromAmount: payAmountStringSchema,
    /** Units of `toAsset` per one unit of `fromAsset`, as the venue quoted it. */
    rate: payAmountStringSchema,
    feeAmount: payAmountStringSchema,
    spreadAmount: payAmountStringSchema,
    /** The least the merchant accepts; a fill below this is refused and reversed. */
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
    quoteId: z.string().uuid(),
  })
  .strict();

export const conversionOrderSchema = z
  .object({
    conversionId: z.string().uuid(),
    requestId: payRequestIdSchema,
    mode: payConversionModeSchema,
    merchantId: payMerchantIdSchema,
    settlementId: z.string().uuid(),
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

export const conversionGetInputSchema = z.object({ conversionId: z.string().uuid() }).strict();
export const conversionListInputSchema = z
  .object({ merchantId: payMerchantIdSchema, status: payConversionStatusSchema.optional(), limit: z.number().int().min(1).max(200) })
  .strict();
