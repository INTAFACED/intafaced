import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { merchantCustomerSeriesInputSchema, merchantCustomerSeriesSchema } from './merchant-portal.js';
import { merchantActivationSchema } from './merchant-activation.js';
import { id, limitInput, cursorInput } from './pay-founder-admin-procedures.js';
import { payPageSchema } from './pay-merchant-reads.js';
import {
  payActivityItemSchema,
  PAY_EXPORT_KINDS,
  payExportJobSchema,
  payExportDownloadSchema,
  payPayoutListItemSchema,
} from './pay-portal-reads.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantOps.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_OPS_CUSTOMERS_SERIES = defineProcedure({
  ...base,
  name: 'pay.merchantOps.customers.series',
  kind: 'query',
  path: 'merchantOps.customers.series',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: merchantCustomerSeriesInputSchema,
  output: merchantCustomerSeriesSchema,
  samples: [
    { verdict: 'accept', input: { customerRef: 'USDC', from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z', bucket: 'day' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_ACTIVATION_GET = defineProcedure({
  ...base,
  name: 'pay.merchantOps.activation.get',
  kind: 'query',
  path: 'merchantOps.activation.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: merchantActivationSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const teamRoles = ['admin', 'finance', 'developer', 'viewer'] as const;

export const memberRoleSchema = z.enum(['owner', ...teamRoles]);

export const teamMeSchema = z.object({ merchantId: z.string(), userId: z.string(), role: memberRoleSchema });

export const evidenceKinds = ['receipt', 'shipping_proof', 'customer_communication', 'terms_accepted', 'identity_check', 'other'] as const;

export const timestamp = z.string().datetime({ offset: true });

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

/** `merchantOps.disputes.getEvidence` on main: the evidence row plus its bytes, for a signed-in session only. */
export const evidenceFileSchema = evidenceSchema.extend({ contentBase64: z.string() });

export const iso = z.string().datetime({ offset: true });

export const customerSummarySchema = z.object({
  customerCount: z.number().int(),
  activeSinceCount: z.number().int(),
  repeatCustomerCount: z.number().int(),
  activeSince: timestamp,
});

export const kybStatusSchema = z.enum(['none', 'pending', 'approved', 'rejected']);

export const kybCurrentSchema = z.object({ kybStatus: kybStatusSchema, kybRef: z.string().nullable(), mode: z.string() });

export const invitationSchema = z.array(
  z.object({ memberId: z.string(), merchantId: z.string(), role: z.enum(teamRoles), invitedAt: timestamp }),
);

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

export const unreadSchema = z.object({ unread: z.number().int() });

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

export const preferenceSchema = z.object({
  kind: z.enum(notificationKinds),
  inApp: z.boolean(),
  threshold: z.string().nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: timestamp.nullable(),
});

/**
 * IN-APP NOTIFICATIONS ONLY. A row here is something a merchant sees when they
 * open the portal. Nothing in this file sends email or SMS, and there is no
 * address or phone column anywhere to send to.
 *
 * The feed is the business's (one feed per merchant) and so is its read state.
 * Preferences are each person's own (J-merchant-01 #6, "saved per person"): a
 * person's view of the feed and their unread count leave out the kinds they
 * turned off; a kind with no row for the person is ON. A `threshold` is
 * whatever the person typed (decimal string); there is no default number.
 */
export const NOTIFICATION_KINDS = [
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

export const stamp = z.string().datetime({ offset: true });

export const healthSchema = z.object({
  asOf: stamp,
  endpoints: z.array(
    z.object({
      endpointId: z.string(),
      status: z.enum(['active', 'disabled']),
      consecutiveFailures: z.number().int().min(0),
      deliveries: z.object({
        pending: z.number().int().min(0),
        delivered: z.number().int().min(0),
        failed: z.number().int().min(0),
        dead: z.number().int().min(0),
        unknown: z.number().int().min(0).optional(),
      }),
      lastDeliveredAt: stamp.nullable(),
    }),
  ),
});

export const attemptsSchema = z.object({
  deliveryId: z.string(),
  attempts: z.array(
    z.object({
      attemptNo: z.number().int().min(1),
      at: stamp,
      outcome: z.enum(['delivered', 'failed', 'unknown']),
      statusCode: z.number().int().nullable(),
      error: z.string().nullable(),
      durationMs: z.number().min(0),
      resend: z.boolean(),
    }),
  ),
});

/** The owner's webhook values; each null is not set. */
export const policySchema = z.object({
  endpointCap: z.number().int().nullable(),
  overlapMaxSeconds: z.number().int().nullable(),
  resendWindowSeconds: z.number().int().nullable(),
  retryScheduleSeconds: z.array(z.number().int()).nullable(),
  resendRate: z.object({ maxPerWindow: z.number().int(), windowMs: z.number().int() }).nullable(),
});

export const guideSchema = z.object({
  headers: z.object({ timestamp: z.string(), signature: z.string(), eventId: z.string() }),
  algorithm: z.string(),
  toleranceSeconds: z.number().int().nullable(),
  senderIps: z.array(z.string()).nullable(),
  vector: z.object({ secret: z.string(), timestamp: z.string(), body: z.string(), signature: z.string() }),
});

/** Which role the caller holds, so the portal can hide what they cannot do. */
export const PAY_MERCHANT_OPS_TEAM_ME = defineProcedure({
  ...base,
  name: 'pay.merchantOps.team.me',
  kind: 'query',
  path: 'merchantOps.team.me',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: teamMeSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_DISPUTES_GET_EVIDENCE = defineProcedure({
  ...base,
  name: 'pay.merchantOps.disputes.getEvidence',
  kind: 'query',
  path: 'merchantOps.disputes.getEvidence',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ evidenceId: id }),
  output: evidenceFileSchema,
  samples: [
    { verdict: 'accept', input: { evidenceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_CUSTOMERS_SUMMARY = defineProcedure({
  ...base,
  name: 'pay.merchantOps.customers.summary',
  kind: 'query',
  path: 'merchantOps.customers.summary',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ activeSince: iso }),
  output: customerSummarySchema,
  samples: [
    { verdict: 'accept', input: { activeSince: '2026-01-01T00:00:00.000Z' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_KYB_CURRENT = defineProcedure({
  ...base,
  name: 'pay.merchantOps.kyb.current',
  kind: 'query',
  path: 'merchantOps.kyb.current',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: kybCurrentSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_TEAM_MY_INVITATIONS = defineProcedure({
  ...base,
  name: 'pay.merchantOps.team.myInvitations',
  kind: 'query',
  path: 'merchantOps.team.myInvitations',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: invitationSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_TEAM_ACCEPT_INVITE = defineProcedure({
  ...base,
  name: 'pay.merchantOps.team.acceptInvite',
  kind: 'mutation',
  path: 'merchantOps.team.acceptInvite',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay' },
  refusals: {},
  input: z.object({ memberId: id }),
  output: memberSchema,
  samples: [
    { verdict: 'accept', input: { memberId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_NOTIFICATIONS_UNREAD_COUNT = defineProcedure({
  ...base,
  name: 'pay.merchantOps.notifications.unreadCount',
  kind: 'query',
  path: 'merchantOps.notifications.unreadCount',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: unreadSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_NOTIFICATIONS_PREFERENCES_LIST = defineProcedure({
  ...base,
  name: 'pay.merchantOps.notifications.preferences.list',
  kind: 'query',
  path: 'merchantOps.notifications.preferences.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: z.array(preferenceSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_NOTIFICATIONS_PREFERENCES_SET = defineProcedure({
  ...base,
  name: 'pay.merchantOps.notifications.preferences.set',
  kind: 'mutation',
  path: 'merchantOps.notifications.preferences.set',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay' },
  refusals: {},
  input: z.object({
    kind: z.enum(NOTIFICATION_KINDS),
    inApp: z.boolean(),
    threshold: z
      .string()
      .regex(/^[0-9]+(\.[0-9]{1,18})?$/)
      .nullish(),
  }),
  output: preferenceSchema,
  samples: [
    { verdict: 'accept', input: { kind: 'payout_awaiting_approval', inApp: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_WEBHOOKS_HEALTH = defineProcedure({
  ...base,
  name: 'pay.merchantOps.webhooks.health',
  kind: 'query',
  path: 'merchantOps.webhooks.health',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: healthSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_WEBHOOKS_DELIVERIES_ATTEMPTS = defineProcedure({
  ...base,
  name: 'pay.merchantOps.webhooks.deliveries.attempts',
  kind: 'query',
  path: 'merchantOps.webhooks.deliveries.attempts',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ deliveryId: id }),
  output: attemptsSchema,
  samples: [
    { verdict: 'accept', input: { deliveryId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_WEBHOOKS_POLICY = defineProcedure({
  ...base,
  name: 'pay.merchantOps.webhooks.policy',
  kind: 'query',
  path: 'merchantOps.webhooks.policy',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: policySchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_WEBHOOKS_GUIDE = defineProcedure({
  ...base,
  name: 'pay.merchantOps.webhooks.guide',
  kind: 'query',
  path: 'merchantOps.webhooks.guide',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: guideSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Merchant activity (portal /pay/activity).
 *
 * A read of rows the merchant already owns: payment events, team changes, KYB
 * transitions, dispute evidence and responses, export jobs, payout approvals,
 * webhook endpoints and deliveries, and each payer detail a teammate unmasked
 * (who, which field; the reason stays in `payment.unmaskReads`). `pay.control_audit` is not a source. That
 * table is the founder control room (captured-over-cap, destination reads,
 * tier and pricing edits).
 *
 * Destinations are masked with the same function the approval view uses. Free
 * text (KYB reasons, dispute notes, webhook payloads, signing secrets) is not
 * selected. Detail keys are an allowlist applied again in process, so a new
 * column cannot leak by being named in SQL alone.
 */
export const ACTIVITY_OBJECT_TYPES = ['payment', 'team', 'kyb', 'dispute', 'export', 'approval', 'webhook'] as const;

export const kybEventSchema = z.object({
  seq: z.string(),
  fromStatus: z.string(),
  toStatus: z.string(),
  kybRef: z.string().nullable(),
  decidedBy: z.enum(['merchant', 'intafaced']),
  reason: z.string().nullable(),
  at: timestamp,
});

export const teamEventSchema = z.object({
  seq: z.string(),
  memberUserId: z.string(),
  action: z.string(),
  fromRole: z.string().nullable(),
  toRole: z.string().nullable(),
  actorId: z.string(),
  createdAt: timestamp,
});

export const exportJobSchema = payExportJobSchema;

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

/** One change to a notification preference (`merchantOps.notifications.preferences.history`): what it was set to, by whom. */
export const preferenceChangeSchema = z.object({
  seq: z.string(),
  kind: z.enum(notificationKinds),
  inApp: z.boolean(),
  threshold: z.string().nullable(),
  actorId: z.string(),
  createdAt: timestamp,
});

export const PAY_MERCHANT_OPS_ACTIVITY_LIST = defineProcedure({
  ...base,
  name: 'pay.merchantOps.activity.list',
  kind: 'query',
  path: 'merchantOps.activity.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({
    limit: limitInput,
    cursor: cursorInput,
    objectType: z.enum(ACTIVITY_OBJECT_TYPES).optional(),
    action: z.string().trim().min(1).max(64).optional(),
    actorId: z.string().trim().min(1).max(128).optional(),
    from: iso.optional(),
    to: iso.optional(),
    search: z.string().trim().min(1).max(200).optional(),
  }),
  output: payPageSchema(payActivityItemSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_TEAM_LIST = defineProcedure({
  ...base,
  name: 'pay.merchantOps.team.list',
  kind: 'query',
  path: 'merchantOps.team.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({
    limit: limitInput,
    cursor: cursorInput,
    status: z.enum(['active', 'invited', 'removed']).optional(),
    role: z.enum(['owner', 'admin', 'finance', 'developer', 'viewer']).optional(),
    search: z.string().trim().min(1).max(200).optional(),
  }),
  output: z.object({ items: z.array(memberSchema), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_KYB_HISTORY = defineProcedure({
  ...base,
  name: 'pay.merchantOps.kyb.history',
  kind: 'query',
  path: 'merchantOps.kyb.history',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ limit: limitInput, cursor: cursorInput }),
  output: z.object({ items: z.array(kybEventSchema), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_TEAM_HISTORY = defineProcedure({
  ...base,
  name: 'pay.merchantOps.team.history',
  kind: 'query',
  path: 'merchantOps.team.history',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ limit: limitInput, cursor: cursorInput }),
  output: z.object({ items: z.array(teamEventSchema), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_EXPORTS_LIST = defineProcedure({
  ...base,
  name: 'pay.merchantOps.exports.list',
  kind: 'query',
  path: 'merchantOps.exports.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({
    limit: limitInput,
    cursor: cursorInput,
    kind: z.enum(PAY_EXPORT_KINDS).optional(),
    status: z.enum(['queued', 'running', 'ready', 'failed', 'expired']).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    from: iso.optional(),
    to: iso.optional(),
  }),
  output: z.object({ items: z.array(exportJobSchema), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_EXPORTS_DOWNLOAD = defineProcedure({
  ...base,
  name: 'pay.merchantOps.exports.download',
  kind: 'query',
  path: 'merchantOps.exports.download',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ jobId: id }),
  output: payExportDownloadSchema,
  samples: [
    { verdict: 'accept', input: { jobId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_NOTIFICATIONS_LIST = defineProcedure({
  ...base,
  name: 'pay.merchantOps.notifications.list',
  kind: 'query',
  path: 'merchantOps.notifications.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({
    limit: limitInput,
    cursor: cursorInput,
    unreadOnly: z.boolean().optional(),
    kind: z.enum(NOTIFICATION_KINDS).optional(),
  }),
  output: z.object({ items: z.array(notificationSchema), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_NOTIFICATIONS_PREFERENCES_HISTORY = defineProcedure({
  ...base,
  name: 'pay.merchantOps.notifications.preferences.history',
  kind: 'query',
  path: 'merchantOps.notifications.preferences.history',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({ limit: limitInput, cursor: cursorInput }),
  output: z.object({ items: z.array(preferenceChangeSchema), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const assetIdIn = z.string().trim().min(1).max(32);

export const PAY_MERCHANT_OPS_EXPORTS_CREATE = defineProcedure({
  ...base,
  name: 'pay.merchantOps.exports.create',
  kind: 'mutation',
  path: 'merchantOps.exports.create',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: z.object({
    requestId: id,
    kind: z.enum(PAY_EXPORT_KINDS),
    filters: z
      .object({
        from: iso.optional(),
        to: iso.optional(),
        status: z.string().max(32).optional(),
        assetId: assetIdIn.optional(),
        amountMin: z.string().optional(),
        amountMax: z.string().optional(),
      })
      .strict()
      .default({}),
    columns: z
      .array(z.string().regex(/^[a-z_]{1,64}$/))
      .max(32)
      .optional(),
    /** M-rep-01: local days in a time zone; the server computes the UTC boundaries. Not combined with filters.from/to. */
    period: z
      .object({
        fromDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        toDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        timeZone: z.string().trim().min(1).max(64),
      })
      .strict()
      .optional(),
  }),
  output: payExportJobSchema,
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111', kind: 'payments' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_TEAM_DECLINE_INVITE = defineProcedure({
  ...base,
  name: 'pay.merchantOps.team.declineInvite',
  kind: 'mutation',
  path: 'merchantOps.team.declineInvite',
  access: { caller: 'signedIn', check: 'membershipExit' },
  refusals: {},
  input: z.object({ memberId: id }),
  output: z.object({ declined: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { memberId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_PAYOUTS_LIST = defineProcedure({
  ...base,
  name: 'pay.merchantOps.payouts.list',
  kind: 'query',
  path: 'merchantOps.payouts.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({
    limit: limitInput,
    cursor: cursorInput,
    status: z.enum(['pending', 'posted', 'paid_out', 'failed']).optional(),
    assetId: assetIdIn.optional(),
    from: iso.optional(),
    to: iso.optional(),
    search: z.string().trim().min(1).max(200).optional(),
  }),
  output: payPageSchema(payPayoutListItemSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const endpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  status: z.enum(['active', 'disabled']),
  disabledReason: z.string().nullish(),
  consecutiveFailures: z.number().int().min(0),
  /** The event types it subscribed to. An older service that does not send them is read as every type. */
  eventTypes: z.array(z.string()).optional(),
  /** While a rolled secret still signs beside the new one: when it stops. */
  previousSecretUntil: stamp.nullish(),
  createdAt: stamp,
  updatedAt: stamp,
});

export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dead', 'unknown'] as const;

export const deliveryStatuses = ['pending', 'delivered', 'failed', 'dead', 'unknown'] as const;

export const deliverySchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  eventId: z.string().optional(),
  eventType: z.string(),
  status: z.enum(deliveryStatuses),
  attempts: z.number().int().min(0),
  lastStatusCode: z.number().int().nullable(),
  latencyMs: z.number().nullish(),
  nextAttemptAt: stamp.nullish(),
  createdAt: stamp,
  deliveredAt: stamp.nullable(),
});

export const PAY_MERCHANT_OPS_WEBHOOKS_LIST = defineProcedure({
  ...base,
  name: 'pay.merchantOps.webhooks.list',
  kind: 'query',
  path: 'merchantOps.webhooks.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({
    limit: limitInput,
    cursor: cursorInput,
    status: z.enum(['active', 'disabled']).optional(),
    search: z.string().trim().min(1).max(500).optional(),
  }),
  output: payPageSchema(endpointSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_OPS_WEBHOOKS_DELIVERIES_LIST = defineProcedure({
  ...base,
  name: 'pay.merchantOps.webhooks.deliveries.list',
  kind: 'query',
  path: 'merchantOps.webhooks.deliveries.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({
    limit: limitInput,
    cursor: cursorInput,
    endpointId: id.optional(),
    status: z.enum(DELIVERY_STATUSES).optional(),
    from: iso.optional(),
    to: iso.optional(),
  }),
  output: payPageSchema(deliverySchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
