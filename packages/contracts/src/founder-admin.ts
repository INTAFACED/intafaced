import { z } from 'zod';
import {
  merchantControlChangeInputSchema,
  merchantControlChangeResultSchema,
  merchantControlProfileSchema,
  merchantLimitRequestSchema,
  payAmountStringSchema,
  payAssetCodeSchema,
  payDestinationKindSchema,
  payMerchantIdSchema,
  payRailIdSchema,
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

/** One `pay.control_audit` row for this merchant. `before` / `after` blobs stay in the table; this is the trail a founder reads. */
export const founderControlAuditEventSchema = z
  .object({
    id: z.string().uuid(),
    seq: z.string().regex(/^[1-9]\d*$/),
    scope: z.enum(['merchant', 'tier', 'pricing', 'approval']),
    scopeId: z.string().min(1).max(128),
    kind: z.string().min(1).max(128),
    outcome: z.string().min(1).max(64),
    actorId: z.string().min(1).max(128),
    secondActorId: z.string().min(1).max(128).nullable(),
    requestId: z.string().uuid().nullable(),
    reason: z.string().min(1).max(4000),
    createdAt: payTimestampSchema,
  })
  .strict();
export type FounderControlAuditEvent = z.infer<typeof founderControlAuditEventSchema>;

/** The same data the merchant sees, plus operator-only fields. */
export const founderMerchantDrilldownSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    displayName: founderMerchantNameSchema,
    legalName: founderMerchantNameSchema,
    /** Account status from `pay.merchants`. Not a tier and not a cap. */
    status: z.enum(['pending', 'active', 'suspended', 'closed']),
    /** Windowed payment and settlement summary from the metrics read model. */
    metrics: merchantMetricsSnapshotSchema,
    control: merchantControlProfileSchema,
    /** Global switches plus this merchant's switches. Other merchants' halt rows are not here. */
    halts: payHaltOperatorStatusSchema,
    pendingApprovals: z.array(payoutApprovalSchema).max(200),
    /** Open limit-increase requests. They are asks, not applied caps. */
    pendingLimitRequests: z.array(merchantLimitRequestSchema).max(200),
    /** Newest first, at most the founder list ceiling (200). */
    recentAudit: z.array(founderControlAuditEventSchema).max(200),
    auditTruncated: z.boolean(),
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

/** One approval on the founder queue. The answer is the stored destination, not the masked list form. */
export const founderApprovalDestinationInputSchema = z.object({ approvalId: z.string().uuid() }).strict();
export const founderApprovalDestinationSchema = z
  .object({
    approvalId: z.string().uuid(),
    railId: payRailIdSchema,
    destinationKind: payDestinationKindSchema,
    /** Exact account or address stored on the approval. Never a merchant-list field. */
    destinationRef: z.string().min(1).max(4000),
  })
  .strict();
export type FounderApprovalDestination = z.infer<typeof founderApprovalDestinationSchema>;
/**
 * Founder queue row. `founderFirstUserId` is the founder who already confirmed, when one has.
 * The same founder must not confirm again; the service also refuses that call.
 * Merchant approval lists use `payoutApprovalSchema` and do not carry this id.
 */
export const founderApprovalQueueItemSchema = payoutApprovalSchema.extend({ founderFirstUserId: z.string().uuid().nullable() }).strict();
export type FounderApprovalQueueItem = z.infer<typeof founderApprovalQueueItemSchema>;
export const founderApprovalQueueSchema = z
  .object({ approvals: z.array(founderApprovalQueueItemSchema), nextCursor: z.string().nullable() })
  .strict();

/** Postgres `bigint` max (2^63−1). One check so a non-digit never reaches `BigInt` (`safeParse` must not throw). */
const PG_BIGINT_MAX = 9223372036854775807n;
const payAuditCursorSchema = z
  .string()
  .refine((value) => /^\d{1,19}$/.test(value) && BigInt(value) <= PG_BIGINT_MAX, 'cursor exceeds bigint max');
export const FOUNDER_CONTROL_AUDIT_SCOPES = ['merchant', 'tier', 'pricing', 'approval'] as const;

/** One append-only `pay.control_audit` row. `before` / `after` are the stored JSON, including `captured_over_cap`. */
export const founderControlAuditEntrySchema = z
  .object({
    id: z.string().uuid(),
    seq: payAuditCursorSchema,
    scope: z.enum(FOUNDER_CONTROL_AUDIT_SCOPES),
    scopeId: z.string().min(1).max(256),
    merchantId: payMerchantIdSchema.nullable(),
    kind: z.string().min(1).max(128),
    outcome: z.string().min(1).max(64),
    actorId: z.string().min(1).max(256),
    secondActorId: z.string().min(1).max(256).nullable(),
    requestId: payRequestIdSchema.nullable(),
    reason: z.string().min(1).max(4000),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
    createdAt: payTimestampSchema,
  })
  .strict();
export type FounderControlAuditEntry = z.infer<typeof founderControlAuditEntrySchema>;

/** Newest first. `from` and `to` are inclusive. A reversed range is refused, not answered as empty. */
export const founderControlAuditListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(200),
    cursor: payAuditCursorSchema.optional(),
    merchantId: payMerchantIdSchema.optional(),
    kind: z.string().trim().min(1).max(128).optional(),
    from: payTimestampSchema.optional(),
    to: payTimestampSchema.optional(),
  })
  .strict();
export type FounderControlAuditListInput = z.infer<typeof founderControlAuditListInputSchema>;
export const founderControlAuditListSchema = z
  .object({ entries: z.array(founderControlAuditEntrySchema), nextCursor: z.string().nullable() })
  .strict();

export const FOUNDER_PENDING_CHANGE_SCOPES = ['merchant', 'tier', 'pricing'] as const;
/** A control change one founder submitted and a different founder has not confirmed yet. */
export const founderPendingChangeSchema = z
  .object({
    requestId: payRequestIdSchema,
    seq: payAuditCursorSchema,
    scope: z.enum(FOUNDER_PENDING_CHANGE_SCOPES),
    scopeId: z.string().min(1).max(256),
    merchantId: payMerchantIdSchema.nullable(),
    /** The stored change target. Confirm with `changeHash` as `expectedChangeHash`. */
    change: z.unknown(),
    changeHash: payChangeHashSchema,
    reason: z.string().min(1).max(4000),
    expectedVersion: z.string().regex(/^(?:0|[1-9]\d*)$/),
    /** Founder who submitted. That same founder cannot confirm. */
    makerUserId: z.string().uuid(),
    createdAt: payTimestampSchema,
  })
  .strict();
export type FounderPendingChange = z.infer<typeof founderPendingChangeSchema>;
export const founderPendingChangeListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(200),
    cursor: payAuditCursorSchema.optional(),
    merchantId: payMerchantIdSchema.optional(),
    scope: z.enum(FOUNDER_PENDING_CHANGE_SCOPES).optional(),
  })
  .strict();
export type FounderPendingChangeListInput = z.infer<typeof founderPendingChangeListInputSchema>;
export const founderPendingChangeListSchema = z
  .object({ changes: z.array(founderPendingChangeSchema), nextCursor: z.string().nullable() })
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
