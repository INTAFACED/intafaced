import { z } from 'zod';
import {
  merchantControlChangeInputSchema,
  merchantControlChangeResultSchema,
  merchantControlProfileSchema,
  payAmountStringSchema,
  payAssetCodeSchema,
  payMerchantIdSchema,
  payReasonSchema,
  payRequestIdSchema,
  payRiskTierIdSchema,
  payTimestampSchema,
  payoutApprovalSchema,
} from './merchant-control.js';
import { merchantMetricsSnapshotSchema, metricsFreshnessSchema, payAssetAmountSchema, payMetricWindowSchema } from './merchant-metrics.js';
import { payHaltOperatorStatusSchema } from './pay-halts.js';

/**
 * FOUNDER ADMIN — wire contract (workstream W0, built by W2/W4).
 *
 * Everything here is founder-only. The router that serves it MUST sit behind
 * founder authority (live entitlement, interactive session, MFA, not an API key
 * and not a sub-account); `admin:read` on a long-lived key is not enough. These
 * shapes never reach a merchant surface, an OpenAPI document, a webhook or a
 * CSV export. The actor is resolved from authentication, never from a body.
 */

export const founderMerchantListInputSchema = z
  .object({
    /** Required and bounded: an unbounded list is an unbounded read of every merchant. */
    limit: z.number().int().min(1).max(200),
    cursor: z.string().max(256).optional(),
    filter: z
      .object({
        status: z.string().max(32).optional(),
        tierId: payRiskTierIdSchema.optional(),
        kybStatus: z.string().max(32).optional(),
        /** Exactly one merchant (the detail page reads its own name this way). */
        merchantId: payMerchantIdSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Merchant names (W4b). Both come from the merchant's own onboarding and are null
 * for a merchant that never gave one; a client shows the id instead and must not
 * invent a name. Trimmed, 1..120 characters, no control characters (enforced in
 * the database).
 */
const founderMerchantNameSchema = z.string().nullable();

export const founderMerchantRowSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    displayName: founderMerchantNameSchema,
    status: z.string(),
    tierId: payRiskTierIdSchema.nullable(),
    kybStatus: z.string(),
    volume: z.array(payAssetAmountSchema),
    revenue: z.array(payAssetAmountSchema),
    openFlags: z.number().int().min(0),
  })
  .strict();
export const founderMerchantListSchema = z
  .object({ freshness: metricsFreshnessSchema, rows: z.array(founderMerchantRowSchema), nextCursor: z.string().nullable() })
  .strict();
export type FounderMerchantList = z.infer<typeof founderMerchantListSchema>;

export const founderMerchantDrilldownInputSchema = z.object({ merchantId: payMerchantIdSchema, window: payMetricWindowSchema }).strict();
/** The same data the merchant sees, plus operator-only fields. */
export const founderMerchantDrilldownSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    displayName: founderMerchantNameSchema,
    legalName: founderMerchantNameSchema,
    metrics: merchantMetricsSnapshotSchema,
    control: merchantControlProfileSchema,
    halts: payHaltOperatorStatusSchema,
    pendingApprovals: z.array(payoutApprovalSchema),
    operator: z
      .object({
        kybStatus: z.string(),
        openFraudReviews: z.number().int().min(0),
        parentMerchantId: payMerchantIdSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type FounderMerchantDrilldown = z.infer<typeof founderMerchantDrilldownSchema>;

export const founderGlobalMetricsInputSchema = z.object({ window: payMetricWindowSchema }).strict();
export const founderGlobalMetricsSchema = z
  .object({
    freshness: metricsFreshnessSchema,
    volume: z.array(payAssetAmountSchema),
    revenue: z.array(payAssetAmountSchema),
    activeMerchants: z.number().int().min(0),
    pendingSettlement: z.array(payAssetAmountSchema),
    openFraudReviews: z.number().int().min(0),
    pendingKyb: z.number().int().min(0),
    onboardingFunnel: z.array(z.object({ step: z.string().max(64), count: z.number().int().min(0) }).strict()),
    railHealth: z.array(z.object({ railId: z.string().max(64), ok: z.boolean(), detail: z.string().nullable() }).strict()),
  })
  .strict();
export type FounderGlobalMetrics = z.infer<typeof founderGlobalMetricsSchema>;

/** Operator changes go through dual control; above a threshold two distinct founders must approve. */
export const founderChangeSubmitInputSchema = merchantControlChangeInputSchema;
export const founderChangeSubmitResultSchema = merchantControlChangeResultSchema;
/** `sha256:<hex>` of the change the confirmer was shown (`founderChangeHash`, entry `@intafaced/contracts/founder-change-hash`). */
export const payChangeHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const founderChangeConfirmInputSchema = z
  .object({
    requestId: payRequestIdSchema,
    decision: z.enum(['confirm', 'reject']),
    reason: payReasonSchema,
    /**
     * REQUIRED. The hash of the change this founder reviewed. svc-pay refuses (`pay.change_hash_mismatch`, nothing applied or
     * declined) unless it equals the hash stored when the first founder submitted: a confirm can only apply what its confirmer saw.
     */
    expectedChangeHash: payChangeHashSchema,
  })
  .strict();

export const founderApprovalQueueInputSchema = z
  .object({ limit: z.number().int().min(1).max(200), cursor: z.string().max(256).optional() })
  .strict();
export const founderApprovalQueueSchema = z
  .object({ approvals: z.array(payoutApprovalSchema), nextCursor: z.string().nullable() })
  .strict();

export const founderTreasuryExposureSchema = z
  .object({
    freshness: metricsFreshnessSchema,
    perAsset: z.array(
      z
        .object({
          assetCode: payAssetCodeSchema,
          /** Null while the conversion path has no inventory reader: "not measured", never zero. */
          openConversionInventory: payAmountStringSchema.nullable(),
          pendingPayouts: payAmountStringSchema,
          /** Null until an owner sets a limit; a missing limit refuses, it is not "unlimited". */
          limit: payAmountStringSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type FounderTreasuryExposure = z.infer<typeof founderTreasuryExposureSchema>;

export const founderRecentActivityInputSchema = z
  .object({ limit: z.number().int().min(1).max(200), since: payTimestampSchema.optional() })
  .strict();
