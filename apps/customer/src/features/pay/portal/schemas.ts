import { z } from 'zod';
import {
  amount,
  asset,
  paymentEventSchema,
  paymentSchema as basePaymentSchema,
  settlementSchema as baseSettlementSchema,
} from '../schemas';

export { paymentEventSchema };

// Browser projections of svc-pay `merchantMetrics.*`, `merchantOps.*` and `merchant.*`.
// Authorities: packages/contracts/src/merchant-metrics.ts, svc-pay/src/merchant-ops/*.
// Money is always a decimal string here. Nothing in this folder converts it to a JS number.

export const page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type Page<T> = { items: T[]; nextCursor: string | null };

const timestamp = z.string().datetime({ offset: true });

// ---- fields added to payments, settlements and approvals (all optional: an older service simply omits them) -----------
// Authorities: packages/contracts/src/pay-merchant-reads.ts and merchant-control.ts. Foundation only parses them;
// the pages decide how to show them.
const failureSchema = z.object({ code: z.string(), message: z.string() });
/** The fee as stored when it was decided. Full for owner, admin and finance; fee only for viewer and developer. Never recomputed. */
export const pricingSnapshotSchema = z.union([
  z.object({
    fee: amount,
    assetCode: asset,
    appliedLayer: z.enum(['global', 'tier', 'merchant']),
    ruleId: z.string(),
    feeBps: z.number(),
    flatFee: amount.nullable(),
    spreadBps: z.number().nullable(),
    roundingBeneficiary: z.enum(['platform', 'merchant']),
    roundingMode: z.enum(['ceil', 'floor']),
    bookedFee: amount.nullable(),
    reserveAmount: amount.nullable(),
    recordedAt: timestamp,
  }),
  z.object({ fee: amount }),
]);
export type PricingSnapshot = z.infer<typeof pricingSnapshotSchema>;
export const paymentSchema = basePaymentSchema.extend({
  pricingSnapshot: pricingSnapshotSchema.nullable().optional(),
  failure: failureSchema.nullable().optional(),
  /** payment.get only: while an open payment waits for confirmations (svc-pay router `payment.get`). */
  // Mirrors payPaymentConfirmationsSchema (packages/contracts/src/pay-merchant-reads.ts); the root contracts entry pulls node code into the browser bundle.
  confirmations: z
    .object({ seen: z.number().int().min(0), required: z.number().int().min(1), asOf: timestamp })
    .strict()
    .nullable()
    .optional(),
});
export const settlementSchema = baseSettlementSchema.extend({
  createdAt: timestamp.nullable().optional(),
  sentAt: timestamp.nullable().optional(),
  settledAt: timestamp.nullable().optional(),
  failedAt: timestamp.nullable().optional(),
  failure: failureSchema.nullable().optional(),
  pricingSnapshot: pricingSnapshotSchema.nullable().optional(),
});
const assetAmount = z.object({ assetCode: asset, amount });
export type AssetAmount = z.infer<typeof assetAmount>;

export const metricPresets = ['today', 'rolling_7d', 'rolling_30d'] as const;
export type MetricPreset = (typeof metricPresets)[number];
export const paymentStatuses = ['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed'] as const;

export const freshnessSchema = z.object({ asOf: timestamp.nullable(), lagSeconds: z.number().int().min(0).nullable() });
export type Freshness = z.infer<typeof freshnessSchema>;

export const snapshotSchema = z.object({
  merchantId: z.string(),
  freshness: freshnessSchema,
  balances: z.array(z.object({ assetCode: asset, clearing: amount, available: amount })),
  paymentCount: z.number().int().min(0),
  statusMix: z.array(z.object({ status: z.enum(paymentStatuses), count: z.number().int().min(0) })),
  captured: z.array(assetAmount),
  refunded: z.array(assetAmount),
  net: z.array(assetAmount),
  settlements: z.array(z.object({ assetCode: asset, gross: amount, fees: amount, net: amount })),
  averagePayment: z.array(assetAmount),
  largestPayment: z.array(assetAmount),
  linkUsage: z.object({ linksUsed: z.number().int().min(0), paymentsViaLinks: z.number().int().min(0) }),
  feeRevenue: z.array(assetAmount),
  conversionVolume: z.array(assetAmount).nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const seriesSchema = z.object({
  merchantId: z.string(),
  freshness: freshnessSchema,
  points: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), assetCode: asset, volume: amount, feeRevenue: amount })),
});
export type Series = z.infer<typeof seriesSchema>;

export const kybStatusSchema = z.enum(['none', 'pending', 'approved', 'rejected']);
export const kybCurrentSchema = z.object({ kybStatus: kybStatusSchema, kybRef: z.string().nullable(), mode: z.string() });
export const kybEventSchema = z.object({
  seq: z.string(),
  fromStatus: z.string(),
  toStatus: z.string(),
  kybRef: z.string().nullable(),
  decidedBy: z.enum(['merchant', 'intafaced']),
  reason: z.string().nullable(),
  at: timestamp,
});
export type KybEvent = z.infer<typeof kybEventSchema>;
export const kybSubmitSchema = z.object({ id: z.string(), kybStatus: kybStatusSchema, kybRef: z.string().nullable() });
export const merchantCreatedSchema = z.object({ id: z.string(), userId: z.string(), mode: z.string(), feeBps: z.number().nullable() });
export const destinationSchema = z.object({ kind: z.string(), ref: z.string(), railId: z.string() });

export const teamRoles = ['admin', 'finance', 'developer', 'viewer'] as const;
export type TeamRole = (typeof teamRoles)[number];
export const memberRoleSchema = z.enum(['owner', ...teamRoles]);
export type MemberRole = z.infer<typeof memberRoleSchema>;
export const memberSchema = z.object({
  memberId: z.string().nullable(),
  userId: z.string(),
  role: memberRoleSchema,
  status: z.enum(['active', 'invited', 'removed']),
  label: z.string().nullable(),
  invitedBy: z.string().nullable(),
  createdAt: timestamp,
  activatedAt: timestamp.nullable(),
  removedAt: timestamp.nullable(),
  cursor: z.string().nullable(),
});
export type Member = z.infer<typeof memberSchema>;
export const teamEventSchema = z.object({
  seq: z.string(),
  memberUserId: z.string(),
  action: z.string(),
  fromRole: z.string().nullable(),
  toRole: z.string().nullable(),
  actorId: z.string(),
  createdAt: timestamp,
});
export type TeamEvent = z.infer<typeof teamEventSchema>;
export const teamMeSchema = z.object({ merchantId: z.string(), userId: z.string(), role: memberRoleSchema });
export const invitationSchema = z.array(
  z.object({ memberId: z.string(), merchantId: z.string(), role: z.enum(teamRoles), invitedAt: timestamp }),
);
export type Invitation = z.infer<typeof invitationSchema>[number];

/**
 * `merchantOps.permissions.catalogue`: the built-in roles and every permission, read from the service's role table. An
 * area is any string, so one the service adds later still shows (under its key) instead of failing the whole page.
 */
export const permissionCatalogueSchema = z.object({
  roles: z.array(
    z.object({
      role: memberRoleSchema,
      builtIn: z.literal(true),
      editable: z.literal(false),
      description: z.string(),
      grants: z.array(z.string()),
    }),
  ),
  areas: z.array(
    z.object({
      area: z.string(),
      permissions: z.array(
        z.object({
          key: z.string(),
          area: z.string(),
          kind: z.enum(['read', 'write']),
          requires: z.array(z.string()),
          heldBy: z.array(memberRoleSchema),
          unheld: z.boolean(),
        }),
      ),
    }),
  ),
});
export type PermissionCatalogue = z.infer<typeof permissionCatalogueSchema>;

export const disputeStatuses = ['open', 'contested', 'accepted', 'won', 'lost'] as const;
export type DisputeStatus = (typeof disputeStatuses)[number];
export const disputeSchema = z.object({
  disputeId: z.string(),
  paymentId: z.string(),
  amount,
  assetId: asset,
  reasonCode: z.string().nullable(),
  status: z.enum(disputeStatuses),
  openedAt: timestamp,
  contestedAt: timestamp.nullable(),
  closedAt: timestamp.nullable(),
  responseDueAt: timestamp.nullable(),
  ledgerWire: z.enum(['posted', 'refused']),
  ledgerRefuseCode: z.string().nullable(),
});
export type Dispute = z.infer<typeof disputeSchema>;
export const disputeSummarySchema = z.object({
  total: z.number().int().min(0),
  byStatus: z.object({
    open: z.number().int(),
    contested: z.number().int(),
    accepted: z.number().int(),
    won: z.number().int(),
    lost: z.number().int(),
  }),
  amountAtRisk: z.array(z.object({ assetId: asset, amount })),
});
export const evidenceKinds = ['receipt', 'shipping_proof', 'customer_communication', 'terms_accepted', 'identity_check', 'other'] as const;
export type EvidenceKind = (typeof evidenceKinds)[number];
export const evidenceSchema = z.object({
  evidenceId: z.string(),
  kind: z.enum(evidenceKinds),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.string(),
  sha256: z.string(),
  note: z.string().nullable(),
  addedBy: z.string(),
  createdAt: timestamp,
});
export type Evidence = z.infer<typeof evidenceSchema>;
export const disputeDetailSchema = disputeSchema.extend({
  canRespond: z.boolean(),
  evidence: z.array(evidenceSchema),
  responses: z.array(
    z.object({
      responseId: z.string(),
      action: z.enum(['contest', 'accept_liability']),
      note: z.string().nullable(),
      resultingStatus: z.string(),
      evidenceCount: z.number().int(),
      respondedBy: z.string(),
      createdAt: timestamp,
    }),
  ),
  payment: z.object({ paymentId: z.string(), status: z.string(), assetId: asset, amount, createdAt: timestamp }).nullable(),
});
export type DisputeDetail = z.infer<typeof disputeDetailSchema>;

const totalsSchema = z.object({ assetId: asset, capturedAmount: amount, refundedAmount: amount, paymentCount: z.number().int() });
export const customerSchema = z.object({
  customerRef: z.string(),
  paymentCount: z.number().int(),
  subscriptionCount: z.number().int(),
  mandateCount: z.number().int(),
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
  totals: z.array(totalsSchema),
});
export type Customer = z.infer<typeof customerSchema>;
export const customerSummarySchema = z.object({
  customerCount: z.number().int(),
  activeSinceCount: z.number().int(),
  repeatCustomerCount: z.number().int(),
  activeSince: timestamp,
});
export const customerDetailSchema = customerSchema.extend({
  recentPayments: z.array(z.object({ paymentId: z.string(), status: z.string(), assetId: asset, amount, createdAt: timestamp })),
});
export type CustomerDetail = z.infer<typeof customerDetailSchema>;

export const exportKinds = ['payments', 'settlements', 'payouts', 'refunds', 'ledger_statement', 'disputes', 'fees'] as const;
export type ExportKind = (typeof exportKinds)[number];
export const exportJobSchema = z.object({
  jobId: z.string(),
  kind: z.enum(exportKinds),
  filters: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    status: z.string().optional(),
    assetId: z.string().optional(),
  }),
  columns: z.array(z.string()),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'expired']),
  failureCode: z.string().nullable(),
  fileName: z.string().nullable(),
  sizeBytes: z.string().nullable(),
  rowCount: z.number().int().nullable(),
  sha256: z.string().nullable(),
  requestedBy: z.string(),
  generatedAt: timestamp.nullable(),
  asOf: timestamp.nullable(),
  expiresAt: timestamp.nullable(),
  createdAt: timestamp,
  completedAt: timestamp.nullable(),
});
export type ExportJob = z.infer<typeof exportJobSchema>;
export const exportDownloadSchema = z.object({
  fileName: z.string(),
  contentType: z.string(),
  content: z.string(),
  sha256: z.string(),
  rowCount: z.number().int(),
});

export const notificationKinds = [
  'payout_awaiting_approval',
  'settlement_failed',
  'payout_failed',
  'limit_threshold',
  'dispute_opened',
  'dispute_due',
  'webhook_failing',
  'operator_pause',
  'export_ready',
  'team_change',
  'payout_destination',
] as const;
export type NotificationKind = (typeof notificationKinds)[number];
export const notificationSchema = z.object({
  notificationId: z.string(),
  kind: z.enum(notificationKinds),
  title: z.string(),
  body: z.string().nullable(),
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  createdAt: timestamp,
  readAt: timestamp.nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;
export const preferenceSchema = z.object({
  kind: z.enum(notificationKinds),
  inApp: z.boolean(),
  threshold: z.string().nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: timestamp.nullable(),
});
export type Preference = z.infer<typeof preferenceSchema>;
/** One change to a notification preference (`merchantOps.notifications.preferences.history`): what it was set to, by whom. */
export const preferenceChangeSchema = z.object({
  seq: z.string(),
  kind: z.enum(notificationKinds),
  inApp: z.boolean(),
  threshold: z.string().nullable(),
  actorId: z.string(),
  createdAt: timestamp,
});
export type PreferenceChange = z.infer<typeof preferenceChangeSchema>;
export const markedSchema = z.object({ marked: z.number().int() });
export const unreadSchema = z.object({ unread: z.number().int() });

export const merchantRecordSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    mode: z.enum(['gateway', 'psp', 'payfac']),
    status: z.enum(['pending', 'active', 'suspended', 'closed']),
    kybStatus: kybStatusSchema,
    kybRef: z.string().nullable(),
    feeBps: z.number().nullable(),
    starterFee: z
      .object({ bps: z.number().int().min(0).max(10_000), source: z.literal('local_test') })
      .nullable()
      .optional(),
  })
  .nullable();
export type MerchantRecord = NonNullable<z.infer<typeof merchantRecordSchema>>;
/** The fee INTAFACED has published for new accounts, exactly as the service states it. `local_test` marks a TEST value. */
export type StarterFee = { bps: number; source: 'local_test' };
export const railSchema = z.array(
  z.object({
    id: z.string(),
    capabilities: z.array(z.string()),
    mode: z.enum(['live', 'sandbox', 'absent']),
    usable: z.boolean(),
    healthy: z.boolean(),
    latencyMs: z.number(),
    reason: z.string().optional(),
  }),
);

// ---- payments, settlements and payouts (W3b) -----------------------------------------------------------
// `payment.*` and `settlement.*` are the pay service's own reads; both are checked on the server against the signed session.
export type Payment = z.infer<typeof paymentSchema>;
export type PaymentEvent = z.infer<typeof paymentEventSchema>;
export type Settlement = z.infer<typeof settlementSchema>;
export type SettlementStatus = Settlement['status'];
export const settlementStatuses = ['pending', 'posted', 'paid_out', 'failed'] as const;

// ---- control room (W1) ----------------------------------------------------------------------------------
// Authority: packages/contracts/src/merchant-control.ts and svc-pay/src/control/schemas.ts. Every number here comes from
// an operator; a null section is "not configured" and is shown as such, never as a default.
const capSchema = z.union([
  z.object({ kind: z.enum(['per_payment', 'daily_intake', 'monthly_intake', 'daily_payout']), assetCode: asset, limit: amount }),
  z.object({ kind: z.literal('beneficiaries_per_day'), limit: z.number().int().min(0) }),
]);
export const capKinds = ['per_payment', 'daily_intake', 'monthly_intake', 'daily_payout', 'beneficiaries_per_day'] as const;
export type CapKind = (typeof capKinds)[number];
const bps = z.number().int().min(0).max(10_000);
export const pricingLayers = ['global', 'tier', 'merchant'] as const;
const pricingRuleSchema = z.object({
  layer: z.enum(pricingLayers),
  scopeId: z.string().nullable(),
  assetCode: asset,
  bands: z.array(z.object({ fromAmount: amount, feeBps: bps, flatFee: amount.nullable() })).min(1),
  spreadBps: bps.nullable(),
  roundingBeneficiary: z.enum(['platform', 'merchant']),
});
export type PricingRule = z.infer<typeof pricingRuleSchema>;
export const controlProfileSchema = z.object({
  merchantId: z.string(),
  tierId: z.string().nullable(),
  archetypeId: z.string().nullable(),
  caps: z.array(capSchema).nullable(),
  pricing: z.array(pricingRuleSchema).nullable(),
  reserve: z.object({ rollingReserveBps: bps.nullable(), holdDays: z.number().int().min(0).nullable() }).nullable(),
  version: z.string(),
  updatedAt: timestamp.nullable(),
});
export type ControlProfile = z.infer<typeof controlProfileSchema>;
export const usageSchema = z.object({
  merchantId: z.string(),
  tierId: z.string().nullable(),
  asOf: timestamp,
  rows: z.array(
    z.object({
      kind: z.enum(capKinds),
      assetCode: asset.nullable(),
      // Counts (new destinations per day) travel as digit strings too, so one exact-decimal rule covers every row.
      limit: amount,
      used: amount.nullable(),
      remaining: amount.nullable(),
      resetsAt: timestamp.nullable(),
    }),
  ),
});
export type Usage = z.infer<typeof usageSchema>;
export type UsageRow = Usage['rows'][number];
export const quoteSchema = z.object({
  ruleId: z.string(),
  appliedLayer: z.enum(pricingLayers),
  monthlyVolumeBefore: amount,
  bandFrom: amount,
  feeBps: bps,
  flatFee: amount.nullable(),
  spreadBps: bps.nullable(),
  roundingBeneficiary: z.enum(['platform', 'merchant']),
  roundingMode: z.enum(['ceil', 'floor']),
  bpsFee: amount,
  feeBeforeClamp: amount,
  fee: amount,
  spread: amount.nullable(),
  net: z.string().regex(/^-?\d+(\.\d{1,18})?$/),
});
export type Quote = z.infer<typeof quoteSchema>;

export const approvalStatuses = ['pending', 'approved', 'rejected', 'voided', 'expired', 'consumed'] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];
export const approvalSchema = z.object({
  approvalId: z.string(),
  merchantId: z.string(),
  settlementId: z.string(),
  amount,
  assetCode: asset,
  payloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  status: z.enum(approvalStatuses),
  makerUserId: z.string(),
  checkerUserId: z.string().nullable(),
  createdAt: timestamp,
  decidedAt: timestamp.nullable(),
  expiresAt: timestamp,
  /** Where the payout would go: the rail, the kind of destination and a masked reference. Never the full account or address. */
  railId: z.string().optional(),
  destinationKind: z.string().optional(),
  destinationMasked: z.string().optional(),
});
export type Approval = z.infer<typeof approvalSchema>;

export const haltScopes = ['intake', 'conversion', 'payout', 'settlement'] as const;
export type HaltScope = (typeof haltScopes)[number];
export const haltStatusSchema = z.object({
  readable: z.boolean(),
  states: z.array(
    z.object({
      scope: z.enum(haltScopes),
      target: z.discriminatedUnion('level', [
        z.object({ level: z.literal('global') }),
        z.object({ level: z.literal('merchant'), merchantId: z.string() }),
        z.object({ level: z.literal('rail'), railId: z.string() }),
      ]),
      halted: z.boolean(),
      changedAt: timestamp.nullable(),
    }),
  ),
});
export type HaltStatus = z.infer<typeof haltStatusSchema>;
