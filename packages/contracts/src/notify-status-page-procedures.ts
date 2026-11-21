import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { noticeCategorySchema, statusPageSchema, statusReadingInputSchema } from './status-page.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-notify `statusPage.*`, one record per call: svc-notify mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-notify', module: 'notify', transport: 'trpc' } as const;

export const POSTMORTEMS_LIST_MAX = 200;

export const postmortemOutput = z.object({
  incidentId: z.string(),
  body: z.string(),
  version: z.number().int(),
  status: z.enum(['draft', 'published']),
  writtenBy: z.string(),
  writtenAt: z.string(),
  publishedAt: z.string().nullable(),
});

export const templateOutput = z.object({
  id: z.string(),
  name: z.string(),
  group: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  impact: z.enum(['none', 'minor', 'major', 'critical']).nullable(),
  components: z.array(z.string()),
  definedBy: z.string(),
  definedAt: z.string(),
});

export const definitionOutput = z.object({
  components: z.array(z.object({ id: z.string(), name: z.string(), group: z.string().nullable(), source: z.string().nullable() })),
  componentCap: z.number().int().nullable(),
  stalenessSeconds: z.number().int().nullable(),
  uptimeDays: z.number().int().nullable(),
  challengeBits: z.number().int().nullable(),
  subscribeRatePerHour: z.number().int().nullable(),
  noticeCategories: z.array(noticeCategorySchema).nullable(),
  revision: z.number().int(),
  updatedAt: z.string().nullable(),
  /** The public site address (no trailing slash) the founder console builds badge snippets on; null when not set. */
  publicOrigin: z.string().nullable(),
});

export const incidentIdInput = z.object({ incidentId: z.string().guid() }).strict();

export const postmortemProposalOutput = z.object({
  actionType: z.string(),
  targetService: z.literal('svc-notify'),
  targetId: z.string(),
  expectedVersion: z.string(),
  payloadHash: z.string(),
});

export const POSTMORTEM_BODY_MAX = 20_000;

export const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

export const templateInput = z
  .object({
    id: z.string().regex(TEMPLATE_ID_PATTERN),
    name: z.string().min(1).max(80),
    group: z.string().max(80).nullable().optional(),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(8000),
    impact: z.enum(['none', 'minor', 'major', 'critical']).nullable().optional(),
    components: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{1,39}$/))
      .max(100)
      .nullable()
      .optional(),
  })
  .strict();

export const maintenanceWindowOutput = z.object({
  notice: z.object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    status: z.enum(['draft', 'published']),
    publishedAt: z.string().nullable(),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    version: z.number().int(),
    components: z.array(z.string()),
    reminderOffsets: z.array(z.number().int()),
    authorId: z.string(),
    createdAt: z.string(),
  }),
  state: z.enum(['scheduled', 'in_progress', 'verifying', 'completed', 'cancelled']).nullable(),
  moves: z.array(z.object({ state: z.string(), movedBy: z.string(), reason: z.string(), movedAt: z.string() })),
  reminders: z.array(
    z.object({ offsetMinutes: z.number().int(), dueAt: z.string(), sentAt: z.string().nullable(), skipped: z.string().nullable() }),
  ),
});

export const delivery = z.object({
  key: z.string(),
  subscriberId: z.string(),
  event: z.string(),
  channel: z.enum(['email', 'webhook']),
  status: z.enum(['pending', 'accepted', 'failed', 'refused']),
  refusalCode: z.string().nullable(),
  attempts: z.number().int(),
});

export const eventRows = z.object({ rows: z.array(delivery.extend({ email: z.string() })), more: z.boolean() });

/** Storage bounds of one founder import, not owner values. */
export const STATUS_IMPORT_MAX = 500;

export const NOTIFY_STATUS_PAGE_POSTMORTEMS_FOR_INCIDENTS = defineProcedure({
  ...base,
  name: 'notify.statusPage.postmortems.forIncidents',
  kind: 'query',
  path: 'statusPage.postmortems.forIncidents',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z.object({ incidentIds: z.array(z.string().guid()).max(POSTMORTEMS_LIST_MAX) }).strict(),
  output: z.array(postmortemOutput),
  samples: [
    { verdict: 'accept', input: { incidentIds: [] } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_STATUS_PAGE_TEMPLATES_LIST = defineProcedure({
  ...base,
  name: 'notify.statusPage.templates.list',
  kind: 'query',
  path: 'statusPage.templates.list',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(templateOutput),
  samples: [{ verdict: 'accept' }],
});

export const NOTIFY_STATUS_PAGE_DEFINITION = defineProcedure({
  ...base,
  name: 'notify.statusPage.definition',
  kind: 'query',
  path: 'statusPage.definition',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: NO_INPUT,
  output: definitionOutput,
  samples: [{ verdict: 'accept' }],
});

export const NOTIFY_STATUS_PAGE_POSTMORTEMS_PROPOSAL = defineProcedure({
  ...base,
  name: 'notify.statusPage.postmortems.proposal',
  kind: 'query',
  path: 'statusPage.postmortems.proposal',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: incidentIdInput,
  output: postmortemProposalOutput,
  samples: [
    { verdict: 'accept', input: { incidentId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_STATUS_PAGE_POSTMORTEMS_WRITE = defineProcedure({
  ...base,
  name: 'notify.statusPage.postmortems.write',
  kind: 'mutation',
  path: 'statusPage.postmortems.write',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z
    .object({
      incidentId: z.string().guid(),
      body: z.string().min(1).max(POSTMORTEM_BODY_MAX),
      expectedVersion: z.number().int().min(0),
    })
    .strict(),
  output: postmortemOutput,
  samples: [
    { verdict: 'accept', input: { incidentId: '11111111-1111-4111-8111-111111111111', body: 'USDC', expectedVersion: 0 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_STATUS_PAGE_POSTMORTEMS_PUBLISH = defineProcedure({
  ...base,
  name: 'notify.statusPage.postmortems.publish',
  kind: 'mutation',
  path: 'statusPage.postmortems.publish',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z
    .object({
      incidentId: z.string().guid(),
      approvalId: z.string().min(1).max(128),
      operationId: z.string().min(1).max(128),
    })
    .strict(),
  output: postmortemOutput,
  samples: [
    { verdict: 'accept', input: { incidentId: '11111111-1111-4111-8111-111111111111', approvalId: 'USDC', operationId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_STATUS_PAGE_TEMPLATES_DEFINE = defineProcedure({
  ...base,
  name: 'notify.statusPage.templates.define',
  kind: 'mutation',
  path: 'statusPage.templates.define',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: templateInput,
  output: templateOutput,
  samples: [
    { verdict: 'accept', input: { id: 'abc', name: 'USDC', title: 'USDC', body: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_STATUS_PAGE_TEMPLATES_RETIRE = defineProcedure({
  ...base,
  name: 'notify.statusPage.templates.retire',
  kind: 'mutation',
  path: 'statusPage.templates.retire',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z.object({ id: z.string().regex(TEMPLATE_ID_PATTERN) }).strict(),
  output: z.object({ id: z.string(), retired: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { id: 'abc' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_STATUS_PAGE_MAINTENANCE_WINDOWS = defineProcedure({
  ...base,
  name: 'notify.statusPage.maintenance.windows',
  kind: 'query',
  path: 'statusPage.maintenance.windows',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z
    .object({ limit: z.number().int().min(1).max(50).default(50) })
    .strict()
    .optional(),
  output: z.array(maintenanceWindowOutput),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_STATUS_PAGE_MAINTENANCE_MOVE = defineProcedure({
  ...base,
  name: 'notify.statusPage.maintenance.move',
  kind: 'mutation',
  path: 'statusPage.maintenance.move',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z
    .object({
      id: z.string().guid(),
      to: z.enum(['verifying', 'completed', 'cancelled', 'in_progress']),
      reason: z.string().min(1).max(500),
    })
    .strict(),
  output: maintenanceWindowOutput,
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111', to: 'verifying', reason: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_STATUS_PAGE_READ = defineProcedure({
  ...base,
  name: 'notify.statusPage.read',
  kind: 'query',
  path: 'statusPage.read',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: statusPageSchema,
  samples: [{ verdict: 'accept' }],
});

export const NOTIFY_STATUS_PAGE_RECORD = defineProcedure({
  ...base,
  name: 'notify.statusPage.record',
  kind: 'mutation',
  path: 'statusPage.record',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: statusReadingInputSchema,
  output: z.object({ componentId: z.string(), state: z.string(), observedAt: z.string(), source: z.string() }),
  samples: [
    { verdict: 'accept', input: { componentId: 'abc', state: 'operational', observedAt: '2026-01-01T00:00:00.000Z', source: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** How each channel leaves this deployment: a channel with no sender is named by its code. */
export const NOTIFY_STATUS_PAGE_SUBSCRIPTIONS_CHANNELS = defineProcedure({
  ...base,
  name: 'notify.statusPage.subscriptions.channels',
  kind: 'query',
  path: 'statusPage.subscriptions.channels',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    email: z.object({ sender: z.enum(['gateway', 'local-outbox']).nullable(), notConnected: z.literal('vendor.email').nullable() }),
    sms: z.literal('vendor.sms'),
    push: z.literal('vendor.push'),
  }),
  samples: [{ verdict: 'accept' }],
});

/** Subscribers newest first, in one state or all, with how their deliveries stand. */
export const NOTIFY_STATUS_PAGE_SUBSCRIPTIONS_LIST = defineProcedure({
  ...base,
  name: 'notify.statusPage.subscriptions.list',
  kind: 'query',
  path: 'statusPage.subscriptions.list',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z.object({ state: z.enum(['unconfirmed', 'active', 'unsubscribed']).nullable(), limit: z.number().int().min(1).max(200) }),
  output: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      state: z.enum(['unconfirmed', 'active', 'unsubscribed']),
      componentIds: z.array(z.string()).nullable(),
      source: z.string().nullable(),
      webhook: z.boolean(),
      createdAt: z.string(),
      deliveries: z.object({
        pending: z.number().int(),
        accepted: z.number().int(),
        failed: z.number().int(),
        refused: z.number().int(),
      }),
    }),
  ),
  samples: [
    { verdict: 'accept', input: { state: 'unconfirmed', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The delivery rows of one published notice: one per subscriber and channel; `more` when there are more than shown. */
export const NOTIFY_STATUS_PAGE_SUBSCRIPTIONS_DELIVERIES = defineProcedure({
  ...base,
  name: 'notify.statusPage.subscriptions.deliveries',
  kind: 'query',
  path: 'statusPage.subscriptions.deliveries',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z.object({ noticeId: z.string().guid() }),
  output: eventRows,
  samples: [
    { verdict: 'accept', input: { noticeId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Tries a published notice's pending and failed rows once more, for subscribers still active. Accepted and refused
 * rows are left, and no row is made for anyone the notice did not reach when it was published.
 */
export const NOTIFY_STATUS_PAGE_SUBSCRIPTIONS_RESEND = defineProcedure({
  ...base,
  name: 'notify.statusPage.subscriptions.resend',
  kind: 'mutation',
  path: 'statusPage.subscriptions.resend',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z.object({ noticeId: z.string().guid() }),
  output: eventRows,
  samples: [
    { verdict: 'accept', input: { noticeId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Founder import: addresses from another list, keyed by address and source; a duplicate makes one record. */
export const NOTIFY_STATUS_PAGE_SUBSCRIPTIONS_IMPORT = defineProcedure({
  ...base,
  name: 'notify.statusPage.subscriptions.import',
  kind: 'mutation',
  path: 'statusPage.subscriptions.import',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z.object({ source: z.string().min(1).max(40), emails: z.array(z.string().max(1000)).min(1).max(STATUS_IMPORT_MAX) }),
  output: z.object({
    received: z.number().int(),
    distinct: z.number().int(),
    added: z.number().int(),
    alreadyKnown: z.number().int(),
    invalid: z.array(z.string()),
    limited: z.number().int(),
  }),
  samples: [
    { verdict: 'accept', input: { source: 'USDC', emails: ['USDC'] } },
    { verdict: 'refuse', input: 42 },
  ],
});
