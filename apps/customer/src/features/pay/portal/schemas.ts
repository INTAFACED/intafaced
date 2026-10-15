import { z } from 'zod';
import { amount, asset } from '../schemas';

// Browser projections of svc-pay `merchantMetrics.*`, `merchantOps.*` and `merchant.*`.
// Authorities: packages/contracts/src/merchant-metrics.ts, svc-pay/src/merchant-ops/*.
// Money is always a decimal string here. Nothing in this folder converts it to a JS number.

export const page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type Page<T> = { items: T[]; nextCursor: string | null };

const timestamp = z.string().datetime({ offset: true });
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

export const exportKinds = ['payments', 'settlements', 'payouts'] as const;
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
  status: z.enum(['queued', 'running', 'ready', 'failed']),
  failureCode: z.string().nullable(),
  fileName: z.string().nullable(),
  sizeBytes: z.string().nullable(),
  rowCount: z.number().int().nullable(),
  sha256: z.string().nullable(),
  requestedBy: z.string(),
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
  updatedAt: timestamp.nullable(),
});
export type Preference = z.infer<typeof preferenceSchema>;
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
  })
  .nullable();
export type MerchantRecord = NonNullable<z.infer<typeof merchantRecordSchema>>;
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
