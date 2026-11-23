import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { merchantCustomerSeriesInputSchema, merchantCustomerSeriesSchema } from './merchant-portal.js';
import { merchantActivationSchema } from './merchant-activation.js';
import { limitInput, cursorInput, id } from './pay-founder-admin-procedures.js';
import { payPageSchema } from './pay-merchant-reads.js';
import { payActivityItemSchema, PAY_EXPORT_KINDS, payExportJobSchema, payExportDownloadSchema } from './pay-portal-reads.js';

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

export const iso = z.string().datetime({ offset: true });

export const teamRoles = ['admin', 'finance', 'developer', 'viewer'] as const;

export const memberRoleSchema = z.enum(['owner', ...teamRoles]);

export const timestamp = z.string().datetime({ offset: true });

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
