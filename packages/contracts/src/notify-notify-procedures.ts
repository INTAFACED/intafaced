import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { NOTICE_CATEGORY_ID, STATUS_COMPONENTS_MAX } from './status-page.js';
import {
  ALERT_CONDITIONS,
  alertEvaluationOutput,
  alertExtras,
  categoryPrefResultOutput,
  categoryPrefRowOutput,
  changelogArea,
  changelogDay,
  changelogInput,
  channelSettingOutput,
  deliveryOutput,
  INCIDENT_PHASES,
  localizedNoticeOutput,
  MAINTENANCE_REMINDER_MINUTES_MAX,
  MAINTENANCE_REMINDERS_MAX,
  NOTICE_AUDIENCES,
  NOTICE_KINDS,
  noticeAsset,
  noticeLanguage,
  noticeNetwork,
  noticeWireOutput,
  operatorDeliveriesInput,
  operatorDeliveryOutput,
  outOfAppChannelSchema,
  priceAlertOutput,
  proposalOutput,
  RECIPIENT_STATES,
  SOURCED_ALERT_KINDS,
  STATUS_COMPONENT_PATTERN,
  statusFeedOutput,
  statusImpact,
  templateOutput,
  UNPUBLISHED_ALERT_KINDS,
  watchRuleOutput,
  webhookAttemptOutput,
  notificationOutput,
} from './notify-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-notify `notify.*`, one record per call: svc-notify mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-notify', module: 'notify', transport: 'trpc' } as const;

/**
 * Owner channel settings (I-order-01). Whether each out-of-app channel has
 * credentials (never the credentials), the owner's on/off switch and the
 * adapter name. A channel with no credentials stays `unconfigured`: a switch
 * cannot make it send.
 */
export const NOTIFY_CHANNEL_SETTINGS = defineProcedure({
  ...base,
  name: 'notify.notify.channelSettings',
  kind: 'query',
  path: 'notify.channelSettings',
  access: { caller: 'scope', scope: 'admin:read', module: 'notify' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(channelSettingOutput),
  samples: [{ verdict: 'accept' }],
});

/** Identity message templates: the newest version of each key and the fields it may use. */
export const NOTIFY_TEMPLATES = defineProcedure({
  ...base,
  name: 'notify.notify.templates',
  kind: 'query',
  path: 'notify.templates',
  access: { caller: 'scope', scope: 'admin:read', module: 'notify' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(templateOutput),
  samples: [{ verdict: 'accept' }],
});

/**
 * The founders' notice desk: drafts and published notices, newest written first, with the incident fields and the
 * author. Drafts never leave this door; the signed-out reads list published rows only.
 */
export const NOTIFY_OPERATOR_NOTICES = defineProcedure({
  ...base,
  name: 'notify.notify.operatorNotices',
  kind: 'query',
  path: 'notify.operatorNotices',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z.object({ kind: z.enum(NOTICE_KINDS).optional(), limit: z.number().int().min(1) }),
  output: z.array(
    noticeWireOutput.extend({
      impact: statusImpact.nullable(),
      components: z.array(z.string()),
      parentId: z.string().guid().nullable(),
      resolves: z.boolean(),
      authorId: z.string(),
      createdAt: z.string(),
    }),
  ),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_DRAFT_NOTICE = defineProcedure({
  ...base,
  name: 'notify.notify.draftNotice',
  kind: 'mutation',
  path: 'notify.draftNotice',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z.object({
    kind: z.enum(NOTICE_KINDS),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(8000),
    startsAt: z.string().datetime({ offset: true }).nullable().optional(),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
    impact: statusImpact.nullable().optional(),
    components: z.array(z.string().regex(STATUS_COMPONENT_PATTERN)).max(STATUS_COMPONENTS_MAX).nullable().optional(),
    parentId: z.string().guid().nullable().optional(),
    resolves: z.boolean().nullable().optional(),
    asset: noticeAsset.nullable().optional(),
    network: noticeNetwork.nullable().optional(),
    phase: z.enum(INCIDENT_PHASES).nullable().optional(),
    changelog: changelogInput.nullable().optional(),
    reminderOffsets: z
      .array(z.number().int().min(1).max(MAINTENANCE_REMINDER_MINUTES_MAX))
      .max(MAINTENANCE_REMINDERS_MAX)
      .nullable()
      .optional(),
    /** One id from the founders' category list (statusPage.configure noticeCategories). */
    category: z.string().regex(NOTICE_CATEGORY_ID).nullable().optional(),
    /** Announcements only: a member audience instead of everyone. */
    audience: z.enum(NOTICE_AUDIENCES).nullable().optional(),
    /**
     * The operator's own title and body in other languages the app offers, keyed by language code. Never machine
     * text; approved with the source text (notices/translations.ts).
     */
    translations: z
      .record(z.string().min(2).max(8), z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(8000) }))
      .nullable()
      .optional(),
    clientRequestId: z.string().min(1).max(128),
  }),
  output: noticeWireOutput,
  samples: [
    { verdict: 'accept', input: { kind: 'announcement', title: 'USDC', body: 'USDC', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** What identity's approval for one draft's publish has to carry: action, target, version and payload hash. */
export const NOTIFY_NOTICE_PROPOSAL = defineProcedure({
  ...base,
  name: 'notify.notify.noticeProposal',
  kind: 'query',
  path: 'notify.noticeProposal',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z.object({ id: z.string().guid() }),
  output: proposalOutput.extend({ actionType: z.literal('notify.notice.publish'), targetService: z.literal('svc-notify') }),
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_PUBLISH_NOTICE = defineProcedure({
  ...base,
  name: 'notify.notify.publishNotice',
  kind: 'mutation',
  path: 'notify.publishNotice',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z.object({
    id: z.string().guid(),
    clientRequestId: z.string().min(1).max(128),
    approvalId: z.string().min(1).max(128),
    operationId: z.string().min(1).max(128),
  }),
  output: noticeWireOutput,
  samples: [
    {
      verdict: 'accept',
      input: { id: '11111111-1111-4111-8111-111111111111', clientRequestId: 'USDC', approvalId: 'USDC', operationId: 'USDC' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Who a notice can be for: `everyone` (the public board) and each member audience, with whether its membership can
 * be read here. `p2p-merchants` is unavailable while P2P_URL is unset.
 */
export const NOTIFY_NOTICE_AUDIENCES = defineProcedure({
  ...base,
  name: 'notify.notify.noticeAudiences',
  kind: 'query',
  path: 'notify.noticeAudiences',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(z.object({ id: z.enum(NOTICE_AUDIENCES), available: z.boolean() })),
  samples: [{ verdict: 'accept' }],
});

/**
 * Recipients by state (active, unconfirmed, quarantined), addresses masked.
 * `thresholdCode` is `notify.quarantine_threshold_unset` until the owner sets
 * the count: nothing is quarantined meanwhile and the page says so. Page size
 * is owner-published like the deliveries list: omit refuses.
 */
export const NOTIFY_OPERATOR_RECIPIENTS = defineProcedure({
  ...base,
  name: 'notify.notify.operatorRecipients',
  kind: 'query',
  path: 'notify.operatorRecipients',
  access: { caller: 'scope', scope: 'admin:read', module: 'notify' },
  refusals: {},
  input: z.object({
    state: z.enum(RECIPIENT_STATES as unknown as [string, ...string[]]),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({
    threshold: z.number().int().nullable(),
    thresholdCode: z.literal('notify.quarantine_threshold_unset').nullable(),
    items: z.array(
      z.object({
        userId: z.string(),
        channel: outOfAppChannelSchema,
        address: z.string(),
        state: z.enum(['active', 'unconfirmed', 'quarantined']),
        consecutiveFailures: z.number().int(),
        lastFailureAt: z.string().nullable(),
        lastFailureCode: z.string().nullable(),
        quarantinedAt: z.string().nullable(),
        quarantineReason: z.string().nullable(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { state: 'active' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Lift a quarantine. Reason required; `reasonId` makes a replay a no-op; audited. */
export const NOTIFY_OPERATOR_RELEASE_RECIPIENT = defineProcedure({
  ...base,
  name: 'notify.notify.operatorReleaseRecipient',
  kind: 'mutation',
  path: 'notify.operatorReleaseRecipient',
  access: { caller: 'scope', scope: 'admin:write', module: 'notify' },
  refusals: {},
  input: z.object({
    userId: z.string().min(1).max(128),
    channel: outOfAppChannelSchema,
    reason: z.string().max(500),
    reasonId: z.string().min(1).max(128),
  }),
  output: z.object({ released: z.literal(true), replayed: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { userId: 'USDC', channel: 'email', reason: 'USDC', reasonId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Operator delivery-outcomes view (`ops.notifications` residual).
 *
 * Cross-user newest-first. `admin:read` only — never `notify:read`, which
 * is self-scoped. `accepted` ≠ end-device delivered (mountain honesty).
 * Bound limit (max 200). Omit is not 50. Canonical door: `notify.ops.deliveries`.
 */
export const NOTIFY_OPERATOR_DELIVERIES = defineProcedure({
  ...base,
  name: 'notify.notify.operatorDeliveries',
  kind: 'query',
  path: 'notify.operatorDeliveries',
  access: { caller: 'scope', scope: 'admin:read', module: 'notify' },
  refusals: {},
  input: operatorDeliveriesInput,
  output: z.array(operatorDeliveryOutput),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Published notices only. Signed-out callers can read this. Drafts are absent. */
export const NOTIFY_NOTICES = defineProcedure({
  ...base,
  name: 'notify.notify.notices',
  kind: 'query',
  path: 'notify.notices',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({
    kind: z.enum(NOTICE_KINDS).optional(),
    limit: z.number().int().min(1),
    /** The id of the last notice of the page before: answers the page after it. */
    after: z.string().guid().optional(),
  }),
  output: z.array(noticeWireOutput),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Out-of-app mute prefs. Critical severity never respects mute (dispatch law). */
export const NOTIFY_MUTE_PREFS = defineProcedure({
  ...base,
  name: 'notify.notify.mutePrefs',
  kind: 'query',
  path: 'notify.mutePrefs',
  access: { caller: 'scope', scope: 'notify:read', module: 'notify' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(
    z.object({
      channel: z.enum(['email', 'push', 'sms']),
      muted: z.boolean(),
    }),
  ),
  samples: [{ verdict: 'accept' }],
});

export const NOTIFY_SET_MUTE = defineProcedure({
  ...base,
  name: 'notify.notify.setMute',
  kind: 'mutation',
  path: 'notify.setMute',
  access: { caller: 'scope', scope: 'notify:write', module: 'notify' },
  refusals: {},
  input: z.object({ channel: z.enum(['email', 'push', 'sms']), muted: z.boolean() }),
  output: z.array(
    z.object({
      channel: z.enum(['email', 'push', 'sms']),
      muted: z.boolean(),
    }),
  ),
  samples: [
    { verdict: 'accept', input: { channel: 'email', muted: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Open funding incidents and maintenance for one asset on one network, for
 * the deposit and withdraw banners. Signed-out. Another network of the same
 * asset is not included. Each incident carries its newest entry and phase.
 */
export const NOTIFY_FUNDING_NOTICES = defineProcedure({
  ...base,
  name: 'notify.notify.fundingNotices',
  kind: 'query',
  path: 'notify.fundingNotices',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ asset: noticeAsset, network: noticeNetwork }),
  output: z.object({
    asset: z.string(),
    network: z.string(),
    incidents: z.array(z.object({ root: noticeWireOutput, latest: noticeWireOutput })),
    maintenance: z.array(noticeWireOutput),
  }),
  samples: [
    { verdict: 'accept', input: { asset: 'USDC', network: 'abc' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_NOTICE = defineProcedure({
  ...base,
  name: 'notify.notify.notice',
  kind: 'query',
  path: 'notify.notice',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ id: z.string().guid() }),
  output: noticeWireOutput,
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Open published incidents and maintenance windows. Signed-out. */
export const NOTIFY_NOTICE_STATUS = defineProcedure({
  ...base,
  name: 'notify.notify.noticeStatus',
  kind: 'query',
  path: 'notify.noticeStatus',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    incidents: z.array(noticeWireOutput),
    maintenance: z.array(noticeWireOutput),
  }),
  samples: [{ verdict: 'accept' }],
});

/**
 * v22.alerts — sourced-mark watchlists (price, funding, liquidation
 * proximity, whale flow).
 *
 * The user surface is create / list / cancel / evaluate. Sweep still
 * runs (`AlertService.evaluateDueAlerts` in `index.ts`). `evaluateAlert`
 * is the public door that must refuse dark/missing marks by name.
 *
 * `evaluation` rides with the list rather than sitting behind its own
 * procedure: a client cannot render somebody's watchlist without also
 * receiving the fact that no watch on it can currently cross.
 *
 * Whale create stores; evaluate refuses `alerts.whale_mark_dark` without
 * a flow mark (a live price is not a volume). Intelligence stays unpublished.
 */
export const NOTIFY_ALERTS = defineProcedure({
  ...base,
  name: 'notify.notify.alerts',
  kind: 'query',
  path: 'notify.alerts',
  access: { caller: 'scope', scope: 'notify:read', module: 'notify' },
  refusals: {},
  input: z
    .object({
      /**
       * Page size. Optional here so omit reaches the named refuse
       * (`notify.alerts_list_limit_unset`) instead of a Zod "Required".
       * Blank is not 20; pass 20 explicitly when that is the page you want.
       */
      limit: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
  output: z.object({ items: z.array(priceAlertOutput), evaluation: alertEvaluationOutput }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_CREATE_ALERT = defineProcedure({
  ...base,
  name: 'notify.notify.createAlert',
  kind: 'mutation',
  path: 'notify.createAlert',
  access: { caller: 'scope', scope: 'notify:write', module: 'notify' },
  refusals: {},
  input: z.union([
    z.object({
      kind: z.literal('price').optional(),
      marketId: z.string().min(1).max(64),
      direction: z.enum(['above', 'below']),
      /**
       * Decimal string. Optional so a blank price reaches
       * `notify.price_unset` instead of a Zod "Required".
       * Blank is not a number.
       */
      targetPrice: z.string().max(64).optional(),
      ...alertExtras,
    }),
    z.object({
      kind: z.enum(SOURCED_ALERT_KINDS).optional(),
      marketId: z.string().min(1).max(64),
      direction: z.enum(['above', 'below']),
      /** Decimal string — never a JSON number. */
      targetPrice: z.string().min(1).max(64),
      ...alertExtras,
    }),
    z.object({
      kind: z.enum(UNPUBLISHED_ALERT_KINDS),
      marketId: z.string().min(1).max(64).optional(),
      direction: z.enum(['above', 'below']).optional(),
      targetPrice: z.string().min(1).max(64).optional(),
    }),
    z.object({
      kind: z.literal('portfolio'),
    }),
  ]),
  output: z.object({ alert: priceAlertOutput, evaluation: alertEvaluationOutput }),
  samples: [
    { verdict: 'accept', input: { marketId: 'USDC', direction: 'above' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_CANCEL_ALERT = defineProcedure({
  ...base,
  name: 'notify.notify.cancelAlert',
  kind: 'mutation',
  path: 'notify.cancelAlert',
  access: { caller: 'scope', scope: 'notify:write', module: 'notify' },
  refusals: {},
  input: z.object({ id: z.string().guid() }),
  output: z.object({ cancelled: z.boolean(), alert: priceAlertOutput.nullable() }),
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Condition eval against the sourced mark. Dark / missing MarkSource
 * refuses `alert.price_unavailable` and never returns fired as live.
 */
export const NOTIFY_EVALUATE_ALERT = defineProcedure({
  ...base,
  name: 'notify.notify.evaluateAlert',
  kind: 'mutation',
  path: 'notify.evaluateAlert',
  access: { caller: 'scope', scope: 'notify:write', module: 'notify' },
  refusals: {},
  input: z.union([
    z.object({ id: z.string().guid() }),
    z.object({ kind: z.enum(UNPUBLISHED_ALERT_KINDS) }),
    z.object({ kind: z.literal('portfolio') }),
  ]),
  output: z.object({
    alert: priceAlertOutput.nullable(),
    outcome: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('hold'), markPrice: z.string() }),
      z.object({ kind: z.literal('fire'), markPrice: z.string() }),
      z.object({
        kind: z.literal('refuse'),
        code: z.enum([
          'alert.price_unavailable',
          'alert.not_active',
          'alert.invalid_price',
          'alert.portfolio_view_unpublished',
          'alert.kind_unpublished',
          'alerts.whale_mark_dark',
          'channel.not_configured',
          'channel.disabled',
        ]),
        detail: z.string(),
      }),
    ]),
    evaluation: alertEvaluationOutput,
  }),
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The category-by-channel grid. `security` and the inbox are locked on.
 * `notConnected` names the delivery vendor a switched-off channel is missing.
 */
export const NOTIFY_CATEGORY_PREFS = defineProcedure({
  ...base,
  name: 'notify.notify.categoryPrefs',
  kind: 'query',
  path: 'notify.categoryPrefs',
  access: { caller: 'scope', scope: 'notify:read', module: 'notify' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(categoryPrefRowOutput),
  samples: [{ verdict: 'accept' }],
});

/** A write to a locked cell stores nothing and answers `locked: true`. */
export const NOTIFY_SET_CATEGORY_PREF = defineProcedure({
  ...base,
  name: 'notify.notify.setCategoryPref',
  kind: 'mutation',
  path: 'notify.setCategoryPref',
  access: { caller: 'scope', scope: 'notify:write', module: 'notify' },
  refusals: {},
  input: z.object({
    category: z.string().min(1).max(32),
    channel: z.string().min(1).max(16),
    enabled: z.boolean(),
    clientRequestId: z.string().min(1).max(128),
  }),
  output: categoryPrefResultOutput,
  samples: [
    { verdict: 'accept', input: { category: 'USDC', channel: 'USDC', enabled: true, clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Change an alert that is active or stopped. Only what is sent changes; `null` clears a name, message or expiry. Checked as a
 * create is: a blank owner setting refuses, a value outside a set one is a bad request. Nothing is written on a refusal.
 */
export const NOTIFY_UPDATE_ALERT = defineProcedure({
  ...base,
  name: 'notify.notify.updateAlert',
  kind: 'mutation',
  path: 'notify.updateAlert',
  access: { caller: 'scope', scope: 'notify:write', module: 'notify' },
  refusals: {},
  input: z.object({
    id: z.string().guid(),
    targetPrice: z.string().min(1).max(64).optional(),
    condition: z.enum(ALERT_CONDITIONS).optional(),
    name: z.string().max(2000).nullable().optional(),
    message: z.string().max(2000).nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    extras: alertExtras.extras,
    frequency: alertExtras.frequency,
    source: alertExtras.source,
  }),
  output: z.object({ alert: priceAlertOutput }),
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Pause (`active: false`) an active alert or resume a stopped one. Repeating it is harmless: the alert is returned as it is. */
export const NOTIFY_SET_ALERT_ACTIVE = defineProcedure({
  ...base,
  name: 'notify.notify.setAlertActive',
  kind: 'mutation',
  path: 'notify.setAlertActive',
  access: { caller: 'scope', scope: 'notify:write', module: 'notify' },
  refusals: {},
  input: z.object({ id: z.string().guid(), active: z.boolean() }),
  output: z.object({ changed: z.boolean(), alert: priceAlertOutput }),
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111', active: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Delete an alert whatever its state. Deleting one that is already gone answers `deleted: false`. */
export const NOTIFY_DELETE_ALERT = defineProcedure({
  ...base,
  name: 'notify.notify.deleteAlert',
  kind: 'mutation',
  path: 'notify.deleteAlert',
  access: { caller: 'scope', scope: 'notify:write', module: 'notify' },
  refusals: {},
  input: z.object({ id: z.string().guid() }),
  output: z.object({ deleted: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The owner's alert webhook policy as the alerts page publishes it (J-charts-desk-10 #4): the ports a webhook may use and the
 * resend schedule. Either blank is `null`, and the page says what that means: no webhook can be saved, or nothing is resent.
 */
export const NOTIFY_ALERT_WEBHOOK_POLICY = defineProcedure({
  ...base,
  name: 'notify.notify.alertWebhookPolicy',
  kind: 'query',
  path: 'notify.alertWebhookPolicy',
  access: { caller: 'scope', scope: 'notify:read', module: 'notify' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    ports: z.array(z.number().int()).nullable(),
    retrySeconds: z.array(z.number().int()).nullable(),
    timeoutMs: z.number().int(),
  }),
  samples: [{ verdict: 'accept' }],
});

/**
 * The person's trigger log: each time an alert fired and the mark that fired it, newest first. The owner sets how long
 * rows are kept; blank refuses `notify.alert_trigger_log_retention_unset` rather than answering an empty list.
 */
export const NOTIFY_ALERT_TRIGGERS = defineProcedure({
  ...base,
  name: 'notify.notify.alertTriggers',
  kind: 'query',
  path: 'notify.alertTriggers',
  access: { caller: 'scope', scope: 'notify:read', module: 'notify' },
  refusals: {},
  input: z.object({ alertId: z.string().guid().optional(), limit: z.number().int().min(1).max(200) }),
  output: z.object({
    retentionDays: z.number().int(),
    items: z.array(
      z.object({
        alertId: z.string().guid(),
        /** Which trigger of the alert this is, from 1. */
        seq: z.number().int(),
        marketId: z.string(),
        condition: z.enum(['crossing', 'crossing_up', 'crossing_down', 'greater_than', 'less_than']),
        targetPrice: z.string(),
        markPrice: z.string(),
        firedAt: z.string(),
        notificationId: z.string().nullable(),
        /** What happened on each channel for this firing, from the fan-out's own rows. In-app is one of them. */
        deliveries: z.array(deliveryOutput),
        /** The webhook's record for this firing, or null when the alert had none. */
        webhook: z
          .object({
            status: z.enum(['pending', 'delivered', 'failed']),
            attempts: z.array(webhookAttemptOutput),
            nextAttemptAt: z.string().nullable(),
          })
          .nullable(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** How many price alerts the person holds open and the cap the owner set. `max: null` is a blank setting: creates refuse. */
export const NOTIFY_ALERT_QUOTA = defineProcedure({
  ...base,
  name: 'notify.notify.alertQuota',
  kind: 'query',
  path: 'notify.alertQuota',
  access: { caller: 'scope', scope: 'notify:read', module: 'notify' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    kind: z.literal('price'),
    used: z.number().int().min(0),
    max: z.number().int().min(1).nullable(),
    /** The burst auto-stop rule, or null while the owner has not set it (the rule is off). */
    burst: z.object({ windowMinutes: z.number().int().min(1), maxTriggers: z.number().int().min(1) }).nullable(),
    /** Most conditions one alert may hold, the main one included (`NOTIFY_ALERT_MAX_CONDITIONS`). Null while the owner has not set it. */
    maxConditions: z.number().int().min(1).nullable(),
  }),
  samples: [{ verdict: 'accept' }],
});

/**
 * A watchlist alert: the same price rule on each market named, one alert per market, all or none. Held to the price-alert
 * quota as a whole (a batch that would pass it creates nothing), and checked like a single create in every other way.
 */
export const NOTIFY_CREATE_ALERTS = defineProcedure({
  ...base,
  name: 'notify.notify.createAlerts',
  kind: 'mutation',
  path: 'notify.createAlerts',
  access: { caller: 'scope', scope: 'notify:write', module: 'notify' },
  refusals: {},
  input: z.object({
    marketIds: z.array(z.string().min(1).max(64)).min(1).max(100),
    direction: z.enum(['above', 'below']),
    /** Decimal string. Optional so a blank price reaches `notify.price_unset` instead of a Zod "Required". */
    targetPrice: z.string().max(64).optional(),
    ...alertExtras,
  }),
  output: z.object({ alerts: z.array(priceAlertOutput).min(1), evaluation: alertEvaluationOutput }),
  samples: [
    { verdict: 'accept', input: { marketIds: ['USDC'], direction: 'above' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The person's watchlist alerts, newest first, each with the markets it covers and why its last sweep added nothing. */
export const NOTIFY_WATCHLIST_ALERTS = defineProcedure({
  ...base,
  name: 'notify.notify.watchlistAlerts',
  kind: 'query',
  path: 'notify.watchlistAlerts',
  access: { caller: 'scope', scope: 'notify:read', module: 'notify' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ items: z.array(watchRuleOutput) }),
  samples: [{ verdict: 'accept' }],
});

/**
 * A watchlist alert (J-charts-desk-09 #7): one price rule on every market of one of the person's watchlists, read from
 * identity. One price alert per market is stored with the rule, all or none, under the price-alert quota; each sweep then
 * adds an alert for a market added to the list since. Refuses `identity.watchlists_unavailable` when identity gives no
 * answer and `alert.watchlist_not_found` for a list the person does not have: never an empty list standing in for either.
 */
export const NOTIFY_CREATE_WATCHLIST_ALERT = defineProcedure({
  ...base,
  name: 'notify.notify.createWatchlistAlert',
  kind: 'mutation',
  path: 'notify.createWatchlistAlert',
  access: { caller: 'scope', scope: 'notify:write', module: 'notify' },
  refusals: {},
  input: z.object({
    listId: z.string().min(1).max(40),
    condition: z.enum(ALERT_CONDITIONS),
    /** Decimal string. Optional so a blank price reaches `notify.price_unset` instead of a Zod "Required". */
    targetPrice: z.string().max(64).optional(),
  }),
  output: z.object({ rule: watchRuleOutput, alerts: z.array(priceAlertOutput).min(1) }),
  samples: [
    { verdict: 'accept', input: { listId: 'USDC', condition: 'crossing' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Stop following a list. The alerts it made stay, each managed on its own. Stopping twice is harmless. */
export const NOTIFY_STOP_WATCHLIST_ALERT = defineProcedure({
  ...base,
  name: 'notify.notify.stopWatchlistAlert',
  kind: 'mutation',
  path: 'notify.stopWatchlistAlert',
  access: { caller: 'scope', scope: 'notify:write', module: 'notify' },
  refusals: {},
  input: z.object({ id: z.string().guid() }),
  output: z.object({ rule: watchRuleOutput.nullable() }),
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Machine-readable status. Signed-out. A component nothing measures reads
 * `unknown`. History is incident minutes per day with no uptime percentage.
 * `days` above the feed maximum is clamped to it.
 */
export const NOTIFY_STATUS_FEED = defineProcedure({
  ...base,
  name: 'notify.notify.statusFeed',
  kind: 'query',
  path: 'notify.statusFeed',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ days: z.number().int().min(1) }),
  output: statusFeedOutput,
  samples: [
    { verdict: 'accept', input: { days: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Published changelog entries, newest first, optionally one area or breaking
 * entries only. Signed-out. An entry with no release date reads `releaseOn: null`.
 */
export const NOTIFY_CHANGELOG = defineProcedure({
  ...base,
  name: 'notify.notify.changelog',
  kind: 'query',
  path: 'notify.changelog',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({
    area: changelogArea.optional(),
    breaking: z.boolean().optional(),
    limit: z.number().int().min(1),
    /** The reader's chosen language: each entry comes in it when the operator wrote it, and names its language. */
    language: noticeLanguage.optional(),
  }),
  output: z.array(localizedNoticeOutput),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Advance notice. Breaking entries whose release date has not passed, soonest
 * first (an entry with no date is never listed), and every endpoint a published
 * entry retires. Signed-out.
 */
export const NOTIFY_UPCOMING_CHANGES = defineProcedure({
  ...base,
  name: 'notify.notify.upcomingChanges',
  kind: 'query',
  path: 'notify.upcomingChanges',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ language: noticeLanguage.optional() }).optional(),
  output: z.object({
    upcoming: z.array(localizedNoticeOutput),
    retired: z.array(z.object({ endpoint: z.string(), entryId: z.string().guid(), title: z.string(), releaseOn: changelogDay.nullable() })),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const NOTIFY_LIST = defineProcedure({
  ...base,
  name: 'notify.notify.list',
  kind: 'query',
  path: 'notify.list',
  access: { caller: 'scope', scope: 'notify:read', module: 'notify' },
  refusals: {},
  input: z
    .object({
      cursor: z.string().guid().optional(),
      /**
       * Page size. Optional here so omit reaches the named refuse
       * (`notify.list_limit_unset`) instead of a Zod "Required".
       * Blank is not 20; pass 20 explicitly when that is the page you want.
       */
      limit: z.number().int().min(1).max(100).optional(),
      unreadOnly: z.boolean().optional(),
    })
    .optional(),
  output: z.object({
    items: z.array(notificationOutput),
    nextCursor: z.string().guid().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
