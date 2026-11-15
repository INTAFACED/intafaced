import { z } from 'zod';
import { payAmountStringSchema, payAssetCodeSchema, payMerchantIdSchema, payTimestampSchema } from './merchant-control.js';

/**
 * MERCHANT METRICS READ MODEL — wire contract (workstream W0, built by W2).
 *
 * Every figure is derived from svc-pay's own events and the ledger, and every
 * response says "as of" when it was projected. A figure with no known freshness
 * must not be painted as live. Amounts are per asset, as decimal strings: two
 * assets are never summed into one number.
 */

export const PAY_METRIC_PRESETS = ['today', 'rolling_7d', 'rolling_30d'] as const;
export const payMetricPresetSchema = z.enum(PAY_METRIC_PRESETS);

/** Either a named preset or an explicit half-open range [from, to). */
export const payMetricWindowSchema = z.union([
  z.object({ kind: z.literal('preset'), preset: payMetricPresetSchema }).strict(),
  z.object({ kind: z.literal('range'), from: payTimestampSchema, to: payTimestampSchema }).strict(),
]);
export type PayMetricWindow = z.infer<typeof payMetricWindowSchema>;

export const payAssetAmountSchema = z.object({ assetCode: payAssetCodeSchema, amount: payAmountStringSchema }).strict();
export type PayAssetAmount = z.infer<typeof payAssetAmountSchema>;

/** Projection freshness. `lagSeconds: null` = unknown, which is never "live". */
export const metricsFreshnessSchema = z
  .object({ asOf: payTimestampSchema.nullable(), lagSeconds: z.number().int().min(0).nullable() })
  .strict();
export type MetricsFreshness = z.infer<typeof metricsFreshnessSchema>;

export const PAY_PAYMENT_STATUSES = ['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed'] as const;
export const payPaymentStatusSchema = z.enum(PAY_PAYMENT_STATUSES);

export const merchantMetricsInputSchema = z.object({ merchantId: payMerchantIdSchema, window: payMetricWindowSchema }).strict();
export type MerchantMetricsInput = z.infer<typeof merchantMetricsInputSchema>;

export const merchantMetricsSnapshotSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    window: payMetricWindowSchema,
    freshness: metricsFreshnessSchema,
    balances: z.array(
      z.object({ assetCode: payAssetCodeSchema, clearing: payAmountStringSchema, available: payAmountStringSchema }).strict(),
    ),
    paymentCount: z.number().int().min(0),
    statusMix: z.array(z.object({ status: payPaymentStatusSchema, count: z.number().int().min(0) }).strict()),
    captured: z.array(payAssetAmountSchema),
    refunded: z.array(payAssetAmountSchema),
    net: z.array(payAssetAmountSchema),
    settlements: z.array(
      z
        .object({ assetCode: payAssetCodeSchema, gross: payAmountStringSchema, fees: payAmountStringSchema, net: payAmountStringSchema })
        .strict(),
    ),
    averagePayment: z.array(payAssetAmountSchema),
    largestPayment: z.array(payAssetAmountSchema),
    linkUsage: z.object({ linksUsed: z.number().int().min(0), paymentsViaLinks: z.number().int().min(0) }).strict(),
    feeRevenue: z.array(payAssetAmountSchema),
    /** Null until conversion exists; never zero-filled. */
    conversionVolume: z.array(payAssetAmountSchema).nullable(),
  })
  .strict();
export type MerchantMetricsSnapshot = z.infer<typeof merchantMetricsSnapshotSchema>;

export const merchantMetricsSeriesInputSchema = z
  .object({ merchantId: payMerchantIdSchema, from: payTimestampSchema, to: payTimestampSchema, bucket: z.literal('day') })
  .strict();

export const merchantMetricsSeriesSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    freshness: metricsFreshnessSchema,
    points: z.array(
      z
        .object({
          day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          assetCode: payAssetCodeSchema,
          volume: payAmountStringSchema,
          feeRevenue: payAmountStringSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type MerchantMetricsSeries = z.infer<typeof merchantMetricsSeriesSchema>;

/**
 * `merchantMetrics.settlementAssets`: every asset a business can settle in, each with its two ledger figures read now.
 *
 * The list is svc-pay's own (`PAY_SETTLEMENT_ASSETS`), never the assets a business happens to hold: a new business sees
 * a row per asset, each reading the ledger's own answer (zero when nothing has posted). Blank refuses
 * `pay.settlement_assets_unset`; it is never filled with a guessed list. A ledger that cannot be read refuses
 * `pay.metrics_balance_unavailable`, so an unreadable balance never reads as zero.
 */
export const merchantSettlementAssetsInputSchema = z.object({ merchantId: payMerchantIdSchema }).strict();
export type MerchantSettlementAssetsInput = z.infer<typeof merchantSettlementAssetsInputSchema>;

export const merchantSettlementAssetsSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    /** When the ledger was read. */
    asOf: payTimestampSchema,
    assets: z
      .array(z.object({ assetCode: payAssetCodeSchema, clearing: payAmountStringSchema, available: payAmountStringSchema }).strict())
      .min(1),
  })
  .strict();
export type MerchantSettlementAssets = z.infer<typeof merchantSettlementAssetsSchema>;

/**
 * The acquiring partner's own terms for one business (CUSTODY-DELTA §1.3 "Unknown, never zero"; OWNER 226): what the
 * partner has told us, and nothing else. Each figure the partner has not given is `{ known: false }`, which the rooms
 * show as "not known", never zero; a feature the partner has said it does not offer is `offered: false`, shown as
 * "not offered by the partner". `partner: 'TEST'` is the labelled TEST acquirer (`card-sandbox`), the only one today.
 */
export const merchantPartnerTermsInputSchema = z.object({ merchantId: payMerchantIdSchema }).strict();
export type MerchantPartnerTermsInput = z.infer<typeof merchantPartnerTermsInputSchema>;

const notKnownSchema = z.object({ known: z.literal(false) }).strict();

export const merchantPartnerTermsSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    partner: z.literal('TEST'),
    /** When the partner's terms were read. */
    asOf: payTimestampSchema,
    /** The partner's reserve rule on this business. */
    reserveRule: z.union([
      notKnownSchema,
      z
        .object({ known: z.literal(true), rollingReserveBps: z.number().int().min(0).max(10_000), holdDays: z.number().int().min(0) })
        .strict(),
    ]),
    /** Who covers what a lost dispute takes beyond the merchant's funds. Never the ledger by default; `house` only when the partner's terms say INTAFACED does. */
    shortfallCover: z.union([notKnownSchema, z.object({ known: z.literal(true), who: z.enum(['merchant', 'partner', 'house']) }).strict()]),
    /** The currencies the partner holds accounts in for this business. */
    currencies: z.union([notKnownSchema, z.object({ known: z.literal(true), offered: z.array(payAssetCodeSchema) }).strict()]),
    /** The partner's instant payout: whether it is offered, and its fee when the partner has given one. */
    instantPayout: z.union([
      notKnownSchema,
      z.object({ known: z.literal(true), offered: z.literal(false) }).strict(),
      z
        .object({
          known: z.literal(true),
          offered: z.literal(true),
          fee: z.union([
            notKnownSchema,
            z.object({ known: z.literal(true), amount: payAmountStringSchema, assetCode: payAssetCodeSchema }).strict(),
          ]),
        })
        .strict(),
    ]),
  })
  .strict();
export type MerchantPartnerTerms = z.infer<typeof merchantPartnerTermsSchema>;
