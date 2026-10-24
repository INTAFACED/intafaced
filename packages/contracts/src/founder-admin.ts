import { z } from 'zod';
import {
  merchantControlChangeInputSchema,
  merchantControlChangeResultSchema,
  merchantControlProfileSchema,
  merchantLimitRequestSchema,
  payAmountStringSchema,
  payAssetCodeSchema,
  payDestinationKindSchema,
  payBpsSchema,
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
import { merchantStarterFeeSchema } from './merchant-portal.js';
import { payDestinationDefaultSchema } from './pay-portal-reads.js';

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
    id: z.string().guid(),
    seq: z.string().regex(/^[1-9]\d*$/),
    scope: z.enum(['merchant', 'tier', 'pricing', 'approval']),
    scopeId: z.string().min(1).max(128),
    kind: z.string().min(1).max(128),
    outcome: z.string().min(1).max(64),
    actorId: z.string().min(1).max(128),
    secondActorId: z.string().min(1).max(128).nullable(),
    requestId: z.string().guid().nullable(),
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
export const founderApprovalDestinationInputSchema = z.object({ approvalId: z.string().guid() }).strict();
export const founderApprovalDestinationSchema = z
  .object({
    approvalId: z.string().guid(),
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
export const founderApprovalQueueItemSchema = payoutApprovalSchema.extend({ founderFirstUserId: z.string().guid().nullable() }).strict();
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
    id: z.string().guid(),
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
    makerUserId: z.string().guid(),
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

/**
 * Founder merchant drill-down (F07–F23) and the founder-wide lists the admin
 * console still cannot fill. Every list is `{ items, nextCursor }`. Amounts stay
 * decimal strings. API key secrets are not in this service: that section says
 * `not_configured` instead of an empty catalog.
 */
export const FOUNDER_MERCHANT_SECTIONS = [
  'payments',
  'refunds',
  'disputes',
  'settlements',
  'payouts',
  'destinations',
  'customers',
  'links',
  'invoices',
  'subscriptions',
  'team',
  'apiKeys',
  'webhooks',
  'deliveries',
  'activity',
  'exports',
  'profile',
] as const;
export type FounderMerchantSection = (typeof FOUNDER_MERCHANT_SECTIONS)[number];

const founderPageLimit = z.number().int().min(1).max(200).optional();
const founderCursor = z.string().min(1).max(512).optional();

export const founderMerchantSectionInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    section: z.enum(FOUNDER_MERCHANT_SECTIONS),
    limit: founderPageLimit,
    cursor: founderCursor,
    filters: z
      .object({
        status: z.string().min(1).max(32).optional(),
        assetId: payAssetCodeSchema.optional(),
        search: z.string().trim().min(1).max(200).optional(),
        from: payTimestampSchema.optional(),
        to: payTimestampSchema.optional(),
        dueAfter: payTimestampSchema.optional(),
        dueBefore: payTimestampSchema.optional(),
        deadline: z.enum(['set', 'unset']).optional(),
        paymentId: z.string().guid().optional(),
        active: z.boolean().optional(),
        role: z.enum(['owner', 'admin', 'finance', 'developer', 'viewer']).optional(),
        endpointId: z.string().guid().optional(),
        kind: z.enum(['payments', 'settlements', 'payouts', 'refunds', 'ledger_statement', 'disputes', 'fees']).optional(),
        objectType: z.enum(['payment', 'team', 'kyb', 'dispute', 'export', 'approval', 'webhook']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FounderMerchantSectionInput = z.infer<typeof founderMerchantSectionInputSchema>;

const feeSnapshotSchema = z
  .object({
    fee: payAmountStringSchema,
    assetCode: payAssetCodeSchema,
    appliedLayer: z.enum(['global', 'tier', 'merchant']),
    ruleId: z.string().guid(),
    recordedAt: payTimestampSchema,
  })
  .strict();

const paymentItemSchema = z
  .object({
    id: z.string().guid(),
    merchantId: payMerchantIdSchema,
    assetId: payAssetCodeSchema,
    amount: payAmountStringSchema,
    capturedAmount: payAmountStringSchema,
    refundedAmount: payAmountStringSchema,
    method: z.string().min(1).max(64),
    railAdapter: z.string().min(1).max(64),
    railRef: z.string().min(1).max(256).nullable(),
    status: z.enum(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']),
    createdAt: payTimestampSchema,
    failureCode: z.string().min(1).max(64).nullable(),
    pricing: feeSnapshotSchema.nullable(),
  })
  .strict();

const refundItemSchema = z
  .object({
    id: z.string().guid(),
    refundId: z.string().min(1).max(128),
    paymentId: z.string().guid(),
    merchantId: payMerchantIdSchema,
    amount: payAmountStringSchema,
    assetId: payAssetCodeSchema,
    reason: z.string().nullable(),
    actor: z.string().guid().nullable(),
    status: z.enum(['posted', 'settled', 'reversed']),
    createdAt: payTimestampSchema,
    settledAt: payTimestampSchema.nullable(),
    source: z.enum(['clearing', 'settled']).nullable(),
    ledgerEffect: z
      .object({
        recorded: z.boolean(),
        pot: z.enum(['clearing', 'merchantProceeds', 'userAvailable']).nullable(),
        ledgerTxId: z.string().guid().nullable(),
        direction: z.enum(['debit', 'credit']).nullable(),
      })
      .strict(),
    payment: z
      .object({
        paymentId: z.string().guid(),
        status: z.enum(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']),
      })
      .strict(),
  })
  .strict();

const disputeItemSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    disputeId: z.string().min(1).max(500),
    paymentId: z.string().min(1).max(80),
    amount: payAmountStringSchema,
    assetId: payAssetCodeSchema,
    reasonCode: z.string().nullable(),
    status: z.enum(['open', 'contested', 'accepted', 'won', 'lost']),
    openedAt: payTimestampSchema,
    contestedAt: payTimestampSchema.nullable(),
    closedAt: payTimestampSchema.nullable(),
    responseDueAt: payTimestampSchema.nullable(),
    responseDueSource: z.enum(['rail_event']).nullable(),
    ledgerWire: z.enum(['posted', 'refused']),
    ledgerRefuseCode: z.string().nullable(),
    /**
     * Posted chargeback transactions. Null when no effect has been recorded.
     * `feePosted` is false: pay pricing has no dispute fee, so none is posted.
     */
    ledgerEffect: z
      .object({
        openingTxId: z.string().nullable(),
        shortfallTxId: z.string().nullable(),
        wonTxId: z.string().nullable(),
        recoveredTxId: z.string().nullable(),
        feePosted: z.literal(false),
        feeNote: z.string().min(1),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

const settlementItemSchema = z
  .object({
    id: z.string().guid(),
    merchantId: payMerchantIdSchema,
    window: z.string().min(1).max(64),
    assetId: payAssetCodeSchema,
    gross: payAmountStringSchema,
    fees: payAmountStringSchema,
    net: payAmountStringSchema,
    status: z.enum(['pending', 'posted', 'paid_out', 'failed']),
    payoutMethod: z.string().min(1).max(64).nullable(),
    payoutReference: z.string().min(1).max(512).nullable(),
    createdAt: payTimestampSchema,
    sentAt: payTimestampSchema.nullable(),
    settledAt: payTimestampSchema.nullable(),
    failedAt: payTimestampSchema.nullable(),
    failureCode: z.string().min(1).max(64).nullable(),
    pricing: feeSnapshotSchema.nullable(),
  })
  .strict();

const destinationItemSchema = z
  .object({
    id: z.string().guid(),
    merchantId: payMerchantIdSchema,
    railId: z.string().min(1).max(64),
    kind: z.string().min(1).max(32),
    destinationMasked: z.string().min(1).max(64),
    screeningState: z.literal('not_recorded'),
    defaultFlag: payDestinationDefaultSchema,
    createdAt: payTimestampSchema,
    lastUsedAt: payTimestampSchema.nullable(),
  })
  .strict();

const customerItemSchema = z
  .object({
    customerRef: z.string().min(1).max(200),
    paymentCount: z.number().int().min(0),
    subscriptionCount: z.number().int().min(0),
    mandateCount: z.number().int().min(0),
    firstSeenAt: payTimestampSchema,
    lastSeenAt: payTimestampSchema,
    totals: z.array(
      z
        .object({
          assetId: payAssetCodeSchema,
          capturedAmount: payAmountStringSchema,
          refundedAmount: payAmountStringSchema,
          paymentCount: z.number().int().min(0),
        })
        .strict(),
    ),
  })
  .strict();

const linkItemSchema = z
  .object({
    id: z.string().guid(),
    prefix: z.string().min(1).max(64),
    label: z.string().max(200),
    amount: payAmountStringSchema.nullable(),
    currency: payAssetCodeSchema.nullable(),
    active: z.boolean(),
    expiresAt: payTimestampSchema.nullable(),
    maxUses: z.number().int().min(0).nullable(),
    uses: z.number().int().min(0),
    createdAt: payTimestampSchema,
  })
  .strict();

const invoiceItemSchema = z
  .object({
    id: z.string().guid(),
    status: z.enum(['draft', 'sent', 'void', 'paid']),
    assetId: payAssetCodeSchema,
    amount: payAmountStringSchema,
    customerRef: z.string().nullable(),
    description: z.string().nullable(),
    paymentLinkId: z.string().guid().nullable(),
    paymentId: z.string().guid().nullable(),
    sentAt: payTimestampSchema.nullable(),
    voidedAt: payTimestampSchema.nullable(),
    paidAt: payTimestampSchema.nullable(),
    createdAt: payTimestampSchema,
  })
  .strict();

const subscriptionItemSchema = z
  .object({
    id: z.string().guid(),
    mandateId: z.string().guid(),
    merchantId: payMerchantIdSchema,
    customerId: z.string().min(1).max(200),
    status: z.enum(['active', 'paused', 'cancelled', 'completed']),
    path: z.string().min(1).max(64),
    nextRunAt: payTimestampSchema,
    createdAt: payTimestampSchema,
    cancelledAt: payTimestampSchema.nullable(),
    pausedAt: payTimestampSchema.nullable(),
    stallReason: z.string().min(1).max(64).nullable(),
  })
  .strict();

const teamItemSchema = z
  .object({
    memberId: z.string().guid().nullable(),
    userId: z.string().min(1).max(128),
    role: z.enum(['owner', 'admin', 'finance', 'developer', 'viewer']),
    status: z.enum(['active', 'invited', 'removed']),
    label: z.string().nullable(),
    invitedBy: z.string().nullable(),
    createdAt: payTimestampSchema,
    activatedAt: payTimestampSchema.nullable(),
    removedAt: payTimestampSchema.nullable(),
  })
  .strict();

const webhookItemSchema = z
  .object({
    id: z.string().guid(),
    url: z.string().min(1).max(2000),
    status: z.enum(['active', 'disabled']),
    disabledReason: z.string().nullable(),
    consecutiveFailures: z.number().int().min(0),
    createdAt: payTimestampSchema,
    updatedAt: payTimestampSchema,
  })
  .strict();

const deliveryItemSchema = z
  .object({
    id: z.string().guid(),
    endpointId: z.string().guid(),
    eventType: z.string().min(1).max(128),
    status: z.enum(['pending', 'delivered', 'failed', 'dead']),
    attempts: z.number().int().min(0),
    lastStatusCode: z.number().int().nullable(),
    createdAt: payTimestampSchema,
    deliveredAt: payTimestampSchema.nullable(),
  })
  .strict();

const activityItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    occurredAt: payTimestampSchema,
    actorId: z.string().min(1).max(128),
    action: z.string().min(1).max(128),
    objectType: z.enum(['payment', 'team', 'kyb', 'dispute', 'export', 'approval', 'webhook']),
    objectId: z.string().min(1).max(500),
    detail: z.record(z.string().max(64), z.string().max(64)),
  })
  .strict();

const exportItemSchema = z
  .object({
    jobId: z.string().guid(),
    kind: z.enum(['payments', 'settlements', 'payouts', 'refunds', 'ledger_statement', 'disputes', 'fees']),
    status: z.enum(['queued', 'running', 'ready', 'failed', 'expired']),
    failureCode: z.string().nullable(),
    fileName: z.string().nullable(),
    sizeBytes: z.string().nullable(),
    rowCount: z.number().int().nullable(),
    requestedBy: z.string().min(1).max(128),
    createdAt: payTimestampSchema,
    completedAt: payTimestampSchema.nullable(),
  })
  .strict();

const kybHistoryItemSchema = z
  .object({
    seq: z.string().regex(/^[1-9]\d*$/),
    fromStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
    toStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
    kybRef: z.string().nullable(),
    decidedBy: z.enum(['merchant', 'intafaced']),
    reason: z.string().nullable(),
    at: payTimestampSchema,
  })
  .strict();

const pageOf = <T extends z.ZodTypeAny>(section: FounderMerchantSection, item: T) =>
  z.object({ section: z.literal(section), items: z.array(item), nextCursor: z.string().nullable() }).strict();

export const founderMerchantSectionSchema = z.discriminatedUnion('section', [
  pageOf('payments', paymentItemSchema),
  pageOf('refunds', refundItemSchema),
  pageOf('disputes', disputeItemSchema),
  pageOf('settlements', settlementItemSchema),
  pageOf(
    'payouts',
    z
      .object({
        id: z.string().guid(),
        merchantId: payMerchantIdSchema,
        window: z.string().min(1).max(64),
        assetId: payAssetCodeSchema,
        gross: payAmountStringSchema,
        fees: payAmountStringSchema,
        net: payAmountStringSchema,
        status: z.enum(['pending', 'posted', 'paid_out', 'failed']),
        payoutMethod: z.string().min(1).max(64).nullable(),
        payoutReference: z.string().min(1).max(512).nullable(),
        createdAt: payTimestampSchema,
      })
      .strict(),
  ),
  pageOf('destinations', destinationItemSchema),
  pageOf('customers', customerItemSchema),
  pageOf('links', linkItemSchema),
  pageOf('invoices', invoiceItemSchema),
  pageOf('subscriptions', subscriptionItemSchema),
  pageOf('team', teamItemSchema),
  z
    .object({
      section: z.literal('apiKeys'),
      catalog: z.literal('not_configured'),
      items: z.array(z.never()),
      nextCursor: z.null(),
    })
    .strict(),
  pageOf('webhooks', webhookItemSchema),
  pageOf('deliveries', deliveryItemSchema),
  pageOf('activity', activityItemSchema),
  pageOf('exports', exportItemSchema),
  z
    .object({
      section: z.literal('profile'),
      current: z
        .object({
          merchantId: payMerchantIdSchema,
          displayName: z.string().nullable(),
          legalName: z.string().nullable(),
          status: z.enum(['pending', 'active', 'suspended', 'closed']),
          mode: z.enum(['gateway', 'psp', 'payfac']),
          kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
          kybRef: z.string().nullable(),
          /** Stored on the merchant row. Null when that row has no fee. */
          feeBps: payBpsSchema.nullable(),
          /** Published local-test starter fee, the same value `merchant.me` returns. Null when it is not set. */
          starterFee: merchantStarterFeeSchema.nullable(),
        })
        .strict(),
      items: z.array(kybHistoryItemSchema),
      nextCursor: z.string().nullable(),
    })
    .strict(),
]);
export type FounderMerchantSectionPage = z.infer<typeof founderMerchantSectionSchema>;

export const founderRecentMerchantsInputSchema = z.object({ limit: founderPageLimit, cursor: founderCursor }).strict();
export const founderRecentMerchantsSchema = z
  .object({
    items: z.array(
      z
        .object({
          merchantId: payMerchantIdSchema,
          displayName: z.string().nullable(),
          legalName: z.string().nullable(),
          status: z.enum(['pending', 'active', 'suspended', 'closed']),
          kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
          createdAt: payTimestampSchema,
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const founderPayoutListInputSchema = z
  .object({
    limit: founderPageLimit,
    cursor: founderCursor,
    status: z.enum(['pending', 'posted', 'paid_out', 'failed']).optional(),
  })
  .strict();
export type FounderPayoutListInput = z.infer<typeof founderPayoutListInputSchema>;
export const founderPayoutListSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().guid(),
          merchantId: payMerchantIdSchema,
          window: z.string().min(1).max(64),
          assetId: payAssetCodeSchema,
          gross: payAmountStringSchema,
          fees: payAmountStringSchema,
          net: payAmountStringSchema,
          status: z.enum(['pending', 'posted', 'paid_out', 'failed']),
          payoutMethod: z.string().min(1).max(64).nullable(),
          payoutReference: z.string().min(1).max(512).nullable(),
          createdAt: payTimestampSchema,
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const founderDisputeListInputSchema = z
  .object({
    limit: founderPageLimit,
    cursor: founderCursor,
    status: z.enum(['open', 'contested', 'accepted', 'won', 'lost']).optional(),
    deadline: z.enum(['set', 'unset']).optional(),
    dueAfter: payTimestampSchema.optional(),
    dueBefore: payTimestampSchema.optional(),
  })
  .strict();
export type FounderDisputeListInput = z.infer<typeof founderDisputeListInputSchema>;
export const founderDisputeListSchema = z.object({ items: z.array(disputeItemSchema), nextCursor: z.string().nullable() }).strict();

const statusCountSchema = z.object({ status: z.string().min(1).max(32), count: z.number().int().min(0) }).strict();
const countWindowSchema = z
  .object({ payments: z.array(statusCountSchema), payouts: z.array(statusCountSchema), refunds: z.array(statusCountSchema) })
  .strict();

export const founderLiveSummarySchema = z
  .object({
    asOf: payTimestampSchema,
    h1: countWindowSchema,
    h24: countWindowSchema,
    queues: z
      .object({
        oldestPendingApprovalAt: payTimestampSchema.nullable(),
        oldestPendingApprovalAgeSeconds: z.number().int().min(0).nullable(),
        oldestPendingPayoutAt: payTimestampSchema.nullable(),
        oldestPendingPayoutAgeSeconds: z.number().int().min(0).nullable(),
        earliestDisputeDeadlineAt: payTimestampSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const founderRiskSummaryInputSchema = z
  .object({
    /** Caller chooses the cutoff. There is no default N. */
    topN: z.number().int().min(1).max(200),
    window: payMetricWindowSchema.optional(),
  })
  .strict();
export type FounderRiskSummaryInput = z.infer<typeof founderRiskSummaryInputSchema>;
export const founderRiskSummarySchema = z
  .object({
    /** Null means every projected day. A missing window is not a hidden 30-day cut. */
    window: payMetricWindowSchema.nullable(),
    /** Latest projected day, or null when the read model has no rows. */
    projectedThrough: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    concentration: z.array(
      z
        .object({
          assetCode: payAssetCodeSchema,
          totalCaptured: payAmountStringSchema,
          /** Share of `totalCaptured` held by the returned merchants, truncated to the ledger scale. Null when the total is zero. */
          topShare: payAmountStringSchema.nullable(),
          merchants: z.array(
            z
              .object({
                merchantId: payMerchantIdSchema,
                captured: payAmountStringSchema,
                share: payAmountStringSchema.nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    failedWorkflows: z
      .object({
        paymentsFailed: z.number().int().min(0),
        payoutsFailed: z.number().int().min(0),
        refundsReversed: z.number().int().min(0),
        webhookDeliveriesFailed: z.number().int().min(0),
        webhookDeliveriesDead: z.number().int().min(0),
        exportsFailed: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
