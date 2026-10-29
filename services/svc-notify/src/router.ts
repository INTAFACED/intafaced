import { z } from 'zod';
import { guestNotificationsRouter } from './guests/router.js';
import { statusPageRouter, type StatusPageDeps } from './status-page/router.js';
import { navMetricsRouter } from './nav-metrics/router.js';
import type { NavMetricStore } from './nav-metrics/counts.js';
import type { GuestNotificationService } from './guests/service.js';
import {
  router,
  publicProcedure,
  scopedProcedure,
  TRPCError,
  STATUS_COMPONENTS_MAX,
  NOTICE_CATEGORY_ID,
  noticeCategorySchema,
} from '@intafaced/contracts';
import {
  NotifyAnnouncementUnsetError,
  NotifyListLimitUnsetError,
  NotifyOperatorDeliveriesLimitUnsetError,
  NotifyVerifyTtlUnsetError,
  NotifyVerifyCodePepperUnsetError,
  assertNotifyListLimit,
  readPublicAnnouncement,
  type NotifyService,
} from './notify-service.js';
import type { DeliveryRecord } from './channel-store.js';
import { providerHealth } from './provider-health.js';
import type { Notification } from './store.js';
import { CHANNEL_IDS, OUT_OF_APP_CHANNELS } from './channels/channel.js';
import { renderInboxCopy } from './channels/render.js';
import {
  AlertLimitError,
  AlertNotEditableError,
  assertNotifyAlertsListLimit,
  NotifyAlertsListLimitUnsetError,
  NotifyPriceUnsetError,
  type AlertService,
} from './alerts/service.js';
import { NOTIFY_ALERT_TRIGGER_LOG_RETENTION_UNSET } from './alerts/trigger-log.js';
import { AlertValidationError } from './alerts/store.js';
import {
  ALERT_CONDITIONS,
  ALERT_FREQUENCIES,
  AlertKindUnpublishedError,
  type AlertCondition,
  type AlertExtra,
  type AlertFrequency,
  EXTRA_CONDITIONS,
  AlertPortfolioUnpublishedError,
  directionOfCondition,
  isSourcedAlertKind,
  isUnpublishedAlertKind,
  SOURCED_ALERT_KINDS,
  UNPUBLISHED_ALERT_KINDS,
  type PriceAlert,
} from './alerts/types.js';
import { describeChannelsPolicy } from './channels-policy.js';
import { PUSH_KEY_UNSET, pushKeyPolicy } from './push-key.js';
import { BLANK_INBOX_SETTINGS, describeInboxPolicy, type InboxSettings } from './inbox-policy.js';
import { describeAlertsPolicy } from './alerts-policy.js';
import { UNWIRED_VENUE_INCIDENT, resolveVenueIncident, venueIncidentOutput, type VenueIncidentLoader } from './venue-incident-truth.js';
import { PreferenceError } from './preferences/account.js';
import { CategoryPrefError } from './preferences/categories.js';
import { QuietHoursError } from './preferences/quiet-hours.js';
import { RecentDeliveriesError } from './preferences/recent.js';
import {
  NOTICE_KINDS,
  INCIDENT_PHASES,
  MAINTENANCE_REMINDER_MINUTES_MAX,
  MAINTENANCE_REMINDERS_MAX,
  NOTICE_ASSET_PATTERN,
  NOTICE_NETWORK_PATTERN,
  NoticeError,
  NOTICES_LIST_LIMIT_MAX,
  STATUS_COMPONENT_PATTERN,
} from './notices/board.js';
import { NOTICE_AUDIENCES } from './notices/audiences.js';
import { CHANGELOG_AREAS } from './notices/changelog.js';
import { OpsConfigError } from './ops-config/four-eyes.js';
import { RECIPIENT_STATES, RecipientHealthError } from './recipient-health.js';
import { TEMPLATE_KEYS } from './ops-config/templates.js';
import { CONTACT_CHANNELS } from './ops-config/contact-policy.js';

/**
 * svc-notify API — inbox, channels, and the delivery record.
 *
 * Every procedure operates on `ctx.principal.userId` and never on a userId from
 * input. Mark-read of another account's ids is a silent no-op at the store
 * (self-only), and the router never accepts a target userId.
 *
 * `notify` is non-custodial and `minTier: 'none'` — the guard's job is scope and
 * region, not verification.
 *
 * WHY `notify.deliveries` IS A USER-FACING PROCEDURE
 *
 * Because the answer belongs to the user. If a margin call was raised and the
 * email never went out, the person whose collateral is at risk is the one who
 * most needs to see `email: refused, channel.not_configured`. Putting that only
 * behind an admin console would leave the honest record where the affected party
 * cannot reach it.
 */

const severitySchema = z.enum(['info', 'action', 'critical']);
const channelSchema = z.enum(CHANNEL_IDS);
const outOfAppChannelSchema = z.enum(OUT_OF_APP_CHANNELS);

const notificationOutput = z.object({
  id: z.string().guid(),
  userId: z.string(),
  kind: z.string(),
  titleKey: z.string(),
  bodyKey: z.string(),
  /** Catalog-resolved title. Unknown keys are the key string, never invented English. */
  title: z.string(),
  /** Catalog-resolved body. Unknown keys are the key string, never invented English. */
  body: z.string(),
  params: z.record(z.string(), z.unknown()),
  href: z.string().nullable(),
  severity: severitySchema,
  readAt: z.string().nullable(),
  sourceSubject: z.string(),
  sourceIdempotencyKey: z.string(),
  createdAt: z.string(),
});

const deliveryOutput = z.object({
  channel: channelSchema,
  status: z.enum(['pending', 'accepted', 'refused', 'failed', 'abandoned']),
  attempts: z.number().int().nonnegative(),
  /** Non-null means a send was attempted. */
  attemptedAt: z.string().nullable(),
  /** Non-null means a transport accepted it. Two different facts, two columns. */
  acceptedAt: z.string().nullable(),
  /** A code, never a sentence — the client renders copy from `@intafaced/i18n`. */
  refusalCode: z.string().nullable(),
});

/**
 * Operator view includes notification id so ops can correlate without user scope.
 * No address / detail / userId — those are not on the delivery row we return.
 * Status vocabulary is the store's (`pending`/`accepted`/`refused`/`failed`/`abandoned`).
 * There is no `delivered` stamp: in-app `accepted` is inbox write; OOA `accepted` is gateway accept.
 */
const operatorDeliveryOutput = deliveryOutput.extend({
  id: z.string().guid(),
  notificationId: z.string().guid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Page size. Optional here so omit reaches the named refuse
 * (`notify.operator_deliveries_limit_unset`) instead of a Zod "Required".
 * Blank is not 50; pass 50 explicitly when that is the page you want.
 */
const operatorDeliveriesInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    status: z.enum(['pending', 'accepted', 'refused', 'failed', 'abandoned']).optional(),
  })
  .optional();

const targetOutput = z.object({
  channel: outOfAppChannelSchema,
  address: z.string(),
  locale: z.string(),
  verifiedAt: z.string().nullable(),
});

/**
 * Address shapes, per channel.
 *
 * Deliberately shallow. No regex can tell a real mailbox from a plausible one —
 * the confirmation code does that, which is why registration always sends one.
 * This check exists only to stop obvious nonsense reaching a gateway.
 */
const registerInput = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('email'), address: z.string().email().max(320), locale: z.string().max(16).optional() }),
  z.object({
    channel: z.literal('sms'),
    // E.164, not a formatting preference: a gateway handed a local-format number
    // still sends it somewhere, and where is nobody's guess but the carrier's.
    address: z.string().regex(/^\+[1-9]\d{6,14}$/, 'must be an E.164 number, e.g. +447700900000'),
    locale: z.string().max(16).optional(),
  }),
  z.object({
    channel: z.literal('push'),
    // Device tokens are opaque strings whose shape belongs to whoever issued
    // them. Bounded, not parsed — parsing would bake a vendor's format into this
    // repository (§0.7).
    address: z.string().min(8).max(4096),
    locale: z.string().max(16).optional(),
  }),
]);

function toWire(n: Notification) {
  const copy = renderInboxCopy(n, 'en');
  return {
    id: n.id,
    userId: n.userId,
    kind: n.kind,
    titleKey: n.titleKey,
    bodyKey: n.bodyKey,
    title: copy.title,
    body: copy.body,
    params: n.params,
    href: n.href,
    severity: n.severity,
    readAt: n.readAt?.toISOString() ?? null,
    sourceSubject: n.sourceSubject,
    sourceIdempotencyKey: n.sourceIdempotencyKey,
    createdAt: n.createdAt.toISOString(),
  };
}

function deliveryToWire(d: DeliveryRecord) {
  return {
    channel: d.channel,
    status: d.status,
    attempts: d.attempts,
    attemptedAt: d.attemptedAt?.toISOString() ?? null,
    acceptedAt: d.acceptedAt?.toISOString() ?? null,
    refusalCode: d.refusalCode,
  };
}

function typedRefusal(err: unknown): never {
  if (
    err instanceof PreferenceError ||
    err instanceof CategoryPrefError ||
    err instanceof QuietHoursError ||
    err instanceof RecentDeliveriesError ||
    err instanceof NoticeError ||
    err instanceof OpsConfigError ||
    err instanceof RecipientHealthError
  ) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  throw err;
}

const channelSettingOutput = z.object({
  channel: outOfAppChannelSchema,
  configured: z.boolean(),
  requires: z.array(z.string()),
  enabled: z.boolean().nullable(),
  adapter: z.string().nullable(),
  version: z.number().int().nonnegative(),
  effective: z.enum(['sending', 'disabled', 'unconfigured']),
  notConnected: z.string().nullable(),
});

const approvalInput = {
  clientRequestId: z.string().min(1).max(128),
  approvalId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
};

const proposalOutput = z.object({ targetId: z.string(), expectedVersion: z.string(), payloadHash: z.string() });
const templateKeySchema = z.enum(TEMPLATE_KEYS);
const templateCopyInput = { key: z.string().min(1).max(64), subject: z.string().max(2000), body: z.string().max(50_000) };

const contactPolicyInput = {
  officialDomains: z.array(z.string().max(253)).max(50).nullable().optional(),
  neverAskStatement: z.string().max(10_000).nullable().optional(),
  contactChannels: z.array(z.string().max(32)).max(20).nullable().optional(),
  smsCarriesLinks: z.boolean().nullable().optional(),
  phishingReport: z.string().max(10_000).nullable().optional(),
};

const contactPolicyOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_published') }),
  z.object({
    status: z.literal('published'),
    version: z.number().int().positive(),
    publishedAt: z.string(),
    officialDomains: z.array(z.string()),
    neverAskStatement: z.string(),
    contactChannels: z.array(z.enum(CONTACT_CHANNELS)),
    smsCarriesLinks: z.boolean(),
    phishingReport: z.string(),
  }),
]);

const templateOutput = z.object({
  key: templateKeySchema,
  fields: z.array(z.string()),
  current: z
    .object({ version: z.number().int().positive(), subject: z.string(), body: z.string(), authorId: z.string(), createdAt: z.string() })
    .nullable(),
});

const typedUnavailable = (what: string): never => {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `notify.${what}_unavailable` });
};

const topicPrefOutput = z.object({
  topic: z.enum(['trade', 'p2p', 'identity', 'bank', 'token', 'agents']),
  channel: channelSchema,
  enabled: z.boolean(),
  configured: z.boolean(),
});

const categoryPrefRowOutput = z.object({
  category: z.enum(['security', 'orders', 'price_alerts', 'promotions', 'news', 'status']),
  channel: z.enum(['email', 'push', 'sms', 'in_app']),
  enabled: z.boolean(),
  locked: z.boolean(),
  configured: z.boolean(),
  notConnected: z.enum(['vendor.email', 'vendor.push', 'vendor.sms']).nullable(),
});

const categoryPrefResultOutput = z.object({
  rows: z.array(categoryPrefRowOutput),
  locked: z.boolean(),
});

const digestOutput = z.object({
  mode: z.enum(['immediate', 'hourly', 'daily']),
  quietHours: z
    .object({
      start: z.string(),
      end: z.string(),
      timeZone: z.string(),
    })
    .nullable(),
});

const recentDeliveryOutput = z.object({
  notificationId: z.string().guid(),
  channel: channelSchema,
  status: z.enum(['pending', 'accepted', 'refused', 'failed', 'abandoned']),
  outcome: z.enum(['sent', 'refused', 'failed']),
  attempts: z.number().int().nonnegative(),
  attemptedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  refusalCode: z.string().nullable(),
});

const statusImpact = z.enum(['none', 'minor', 'major', 'critical']);
const statusComponentId = z.enum(['api', 'webhooks', 'console']);

const statusFeedOutput = z.object({
  asOf: z.string(),
  components: z.array(
    z.object({
      component: statusComponentId,
      state: z.enum(['unknown', 'maintenance', 'degraded', 'partial_outage', 'major_outage']),
      basis: z.enum(['incident', 'maintenance', 'no_measurement']),
      since: z.string().nullable(),
    }),
  ),
  incidents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      impact: statusImpact.nullable(),
      components: z.array(statusComponentId),
      openedAt: z.string(),
      resolvedAt: z.string().nullable(),
      updates: z.array(
        z.object({
          id: z.string(),
          body: z.string(),
          impact: statusImpact.nullable(),
          publishedAt: z.string(),
          resolves: z.boolean(),
        }),
      ),
    }),
  ),
  maintenance: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      components: z.array(statusComponentId),
      startsAt: z.string().nullable(),
      endsAt: z.string().nullable(),
    }),
  ),
  history: z.object({
    basis: z.literal('incident_notices_only'),
    days: z.array(
      z.object({
        date: z.string(),
        components: z.array(
          z.object({ component: statusComponentId, incidentMinutes: z.number().int().min(0), worstImpact: statusImpact.nullable() }),
        ),
      }),
    ),
  }),
});

const changelogArea = z.enum(CHANGELOG_AREAS);
const changelogDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const changelogOutput = z.object({
  area: changelogArea,
  breaking: z.boolean(),
  endpoints: z.array(z.string()),
  scopes: z.array(z.string()),
  addedOn: changelogDay.nullable(),
  releaseOn: changelogDay.nullable(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  migrationNote: z.string().nullable(),
  retired: z.array(z.string()),
});

/** What an author sends for a changelog entry. Area, dates and the rest are validated again on the board. */
const changelogInput = z.object({
  area: z.string().max(32).nullable().optional(),
  breaking: z.boolean().nullable().optional(),
  endpoints: z.array(z.string().max(200)).max(50).nullable().optional(),
  scopes: z.array(z.string().max(200)).max(50).nullable().optional(),
  addedOn: changelogDay.nullable().optional(),
  releaseOn: changelogDay.nullable().optional(),
  before: z.string().max(4000).nullable().optional(),
  after: z.string().max(4000).nullable().optional(),
  migrationNote: z.string().max(4000).nullable().optional(),
  retired: z.array(z.string().max(200)).max(50).nullable().optional(),
});

const noticeWireOutput = z.object({
  id: z.string().guid(),
  kind: z.enum(NOTICE_KINDS),
  title: z.string(),
  body: z.string(),
  status: z.enum(['draft', 'published']),
  publishedAt: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  version: z.number().int(),
  asset: z.string().nullable(),
  network: z.string().nullable(),
  phase: z.enum(INCIDENT_PHASES).nullable(),
  changelog: changelogOutput.nullable(),
  category: noticeCategorySchema.nullable(),
  audience: z.enum(NOTICE_AUDIENCES),
});

const noticeAsset = z.string().regex(NOTICE_ASSET_PATTERN);
const noticeNetwork = z.string().regex(NOTICE_NETWORK_PATTERN);

function operatorDeliveryToWire(d: DeliveryRecord) {
  return {
    id: d.id,
    notificationId: d.notificationId,
    ...deliveryToWire(d),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

async function loadOperatorDeliveries(notify: NotifyService, limit: number | undefined, status?: DeliveryRecord['status']) {
  try {
    return (await notify.operatorDeliveryOutcomes(limit, status)).map(operatorDeliveryToWire);
  } catch (err) {
    if (err instanceof NotifyOperatorDeliveriesLimitUnsetError) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: err.message,
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * What an alert may carry beyond market, side and price (C-alerts-scan-01). The lengths here are only an input bound; the owner's
 * limits are checked by the service, which refuses when they are blank.
 */
const alertExtras = {
  /** How the mark is compared with the target. Omitted: a level in the direction given. */
  condition: z.enum(ALERT_CONDITIONS).optional(),
  name: z.string().max(2000).optional(),
  message: z.string().max(2000).optional(),
  /** ISO time. Omitted: open-ended. */
  expiresAt: z.string().datetime({ offset: true }).optional(),
  /** `once` (the default) or a repeating frequency the owner allows; a repeating alert must be a crossing. */
  frequency: z.enum(ALERT_FREQUENCIES).optional(),
  /** Added level conditions on the same market; all must hold with the main one. */
  extras: z
    .array(z.object({ condition: z.enum(EXTRA_CONDITIONS), targetPrice: z.string().min(1).max(64) }))
    .max(20)
    .optional(),
};

const priceAlertOutput = z.object({
  id: z.string().guid(),
  userId: z.string(),
  marketId: z.string(),
  kind: z.enum(SOURCED_ALERT_KINDS),
  direction: z.enum(['above', 'below']),
  targetPrice: z.string(),
  status: z.enum(['active', 'fired', 'cancelled', 'expired', 'stopped']),
  firedAt: z.string().nullable(),
  createdAt: z.string(),
  condition: z.enum(ALERT_CONDITIONS),
  name: z.string().nullable(),
  message: z.string().nullable(),
  expiresAt: z.string().nullable(),
  updatedAt: z.string(),
  extras: z.array(z.object({ condition: z.enum(EXTRA_CONDITIONS), targetPrice: z.string() })),
  frequency: z.enum(ALERT_FREQUENCIES),
  /** Times a repeating alert has triggered; zero for a one-shot alert. */
  fireCount: z.number().int(),
  /** Why a stopped alert was stopped by the platform: `burst` (it triggered too often). Null for a pause by the person. */
  stopReason: z.enum(['burst']).nullable(),
  lastFiredAt: z.string().nullable(),
});

/**
 * WHETHER A WATCH CAN FIRE — returned with the watchlist and with every watch
 * created, not parked behind a procedure a client might not call.
 *
 * D-S-13 done-bar item 6: reclassifying a promise-with-no-delivery requires the
 * disclosure to exist in code at the surface a user reads. Somebody who has just
 * created a price watch is exactly the person entitled to know that this
 * deployment has no mark feed and therefore nothing will cross.
 *
 * Codes, never sentences — clients render copy from `@intafaced/i18n` (§9), and
 * `canFire: true` is a statement about wiring, never an SLA (§8 item 9).
 */
const alertEvaluationOutput = z.object({
  markSource: z.enum(['dark', 'live']),
  canFire: z.boolean(),
  code: z.enum(['alert.price_unavailable', 'alerts.whale_mark_dark', 'channel.not_configured', 'channel.disabled']).nullable(),
});

/** The answer when this deployment has no alert service at all. */
const NO_ALERT_SERVICE = { markSource: 'dark', canFire: false, code: 'alert.price_unavailable' } as const;

/** The refusals an edit or pause can raise, as tRPC errors. Anything else is not ours to hide. */
function alertManagerError(err: unknown): unknown {
  if (err instanceof TRPCError) return err;
  if (err instanceof NotifyPriceUnsetError) return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  if (err instanceof AlertNotEditableError) return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  if (err instanceof AlertLimitError) {
    return new TRPCError({
      code: err.code.startsWith('notify.') || err.code === 'alert.quota_reached' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST',
      message: err.message,
      cause: err,
    });
  }
  return err;
}

function priceAlertToWire(row: PriceAlert) {
  return {
    id: row.id,
    userId: row.userId,
    marketId: row.marketId,
    kind: row.kind,
    direction: row.direction,
    targetPrice: row.targetPrice,
    status: row.status,
    firedAt: row.firedAt ? row.firedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    condition: row.condition,
    name: row.name,
    message: row.message,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    extras: row.extras.map((e) => ({ condition: e.condition, targetPrice: e.targetPrice })),
    frequency: row.frequency,
    fireCount: row.fireCount,
    stopReason: row.stopReason,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
  };
}

/**
 * @param alerts Optional v22.alerts MVP service. When absent, alert procedures
 * refuse with a clear shape rather than inventing a silent empty list that
 * pretends the feature is live.
 * @param loadVenueIncident Matching halt / incident-silence truth. Default is
 * unwired — `ok` is process liveness, never an invented all-clear.
 */
export function createNotifyRouter(
  notify: NotifyService,
  alerts?: AlertService,
  loadVenueIncident?: VenueIncidentLoader,
  guests?: GuestNotificationService,
  inbox: InboxSettings = BLANK_INBOX_SETTINGS,
  statusPage?: StatusPageDeps,
  navMetrics?: NavMetricStore,
) {
  return router({
    guestNotifications: guestNotificationsRouter(guests),
    navMetrics: navMetricsRouter(navMetrics),
    statusPage: statusPageRouter(statusPage),
    health: publicProcedure
      .output(
        z.object({
          ok: z.boolean(),
          service: z.literal('svc-notify'),
          fanoutEnabled: z.boolean(),
          venueIncident: venueIncidentOutput,
        }),
      )
      .query(async () => ({
        ok: true,
        service: 'svc-notify' as const,
        fanoutEnabled: notify.fanoutEnabled,
        venueIncident: await resolveVenueIncident(loadVenueIncident ?? (() => UNWIRED_VENUE_INCIDENT)),
      })),

    notify: router({
      list: scopedProcedure('notify:read', { module: 'notify' })
        .input(
          z
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
        )
        .output(
          z.object({
            items: z.array(notificationOutput),
            nextCursor: z.string().guid().nullable(),
          }),
        )
        .query(async ({ ctx, input }) => {
          try {
            const result = await notify.list({
              userId: ctx.principal.userId,
              cursor: input?.cursor ?? null,
              limit: assertNotifyListLimit(input?.limit),
              unreadOnly: input?.unreadOnly ?? false,
            });
            return {
              items: result.items.map(toWire),
              nextCursor: result.nextCursor,
            };
          } catch (err) {
            if (err instanceof NotifyListLimitUnsetError) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: err.message,
                cause: err,
              });
            }
            throw err;
          }
        }),

      unreadCount: scopedProcedure('notify:read', { module: 'notify' })
        .output(z.object({ count: z.number().int().nonnegative() }))
        .query(async ({ ctx }) => ({ count: await notify.unreadCount(ctx.principal.userId) })),

      markRead: scopedProcedure('notify:write', { module: 'notify' })
        .input(z.object({ ids: z.array(z.string().guid()).min(1).max(100) }))
        .output(z.object({ marked: z.number().int().nonnegative() }))
        .mutation(async ({ ctx, input }) => ({
          marked: await notify.markRead(ctx.principal.userId, input.ids),
        })),

      markAllRead: scopedProcedure('notify:write', { module: 'notify' })
        .output(z.object({ marked: z.number().int().nonnegative() }))
        .mutation(async ({ ctx }) => ({
          marked: await notify.markAllRead(ctx.principal.userId),
        })),

      /**
       * Fan-out mountain vs §13 socket honesty (D26-P1-O5).
       *
       * Static board — integrators read this before wiring UI. Does not reflect
       * runtime credentials; use `channels` for configured vs unprobed.
       */
      channelsPolicy: publicProcedure.query(() => describeChannelsPolicy()),

      /**
       * The push gateway's public application key, which a browser needs to create a device subscription
       * (HM-notifications-02). Public by design; null with `notify.push_key_unset` until the owner configures push
       * delivery (key, gateway URL and token), so the app shows the permission state and never registers a device that
       * nothing could reach.
       */
      pushKey: publicProcedure
        .output(
          z.union([
            z.object({ publicKey: z.string(), unsetCode: z.null() }),
            z.object({ publicKey: z.null(), unsetCode: z.literal(PUSH_KEY_UNSET) }),
          ]),
        )
        .query(() => pushKeyPolicy(process.env)),

      /**
       * v22.alerts refuse honesty — price watch core, unpublished kinds, dark marks.
       *
       * Static board — integrators read this before wiring watch UI. Does not
       * reflect runtime mark wiring; use `alerts` / `evaluateAlert` for that.
       */
      alertsPolicy: publicProcedure.query(() => describeAlertsPolicy()),

      /**
       * Notification centre owner values — page size, unread cap, retention.
       * Blank values report unset with their typed code; nothing is defaulted.
       */
      inboxPolicy: publicProcedure.query(() => describeInboxPolicy(inbox)),

      /**
       * Public announcement. Real content is not published here.
       * Caller text is ignored. The slot stays empty.
       */
      announcement: publicProcedure
        .input(z.object({ text: z.string().max(2000).optional() }).optional())
        .output(noticeWireOutput)
        .query(async () => {
          const current = notify.notices ? await notify.notices.currentAnnouncement() : null;
          if (current) return current;
          try {
            return readPublicAnnouncement();
          } catch (err) {
            if (err instanceof NotifyAnnouncementUnsetError) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: err.message,
                cause: err,
              });
            }
            throw err;
          }
        }),

      /**
       * Which channels are configured vs unprobed, and what is missing.
       *
       * `requires` names environment variables — an operator instruction in a
       * user-facing response, deliberately. This platform is run by its owner,
       * the same person reads both surfaces, and a vaguer answer would send them
       * into the source to find out which key is absent. It names no provider,
       * only our own variable names (§0.7).
       *
       * `socket` is the Doctrine §13 tracker id for out-of-app channels
       * (`socket.notify-email|push|sms`). Null for `inapp` — that is the
       * fan-out mountain (`ops.notifications`), not a credential socket
       * (D26-P1-O5). Closing a socket needs Class X credentials; refusing
       * when unset is the honest state, not a half-built channel.
       */
      channels: scopedProcedure('notify:read', { module: 'notify' })
        .output(
          z.array(
            z.object({
              channel: channelSchema,
              configured: z.boolean(),
              available: z.boolean(),
              reason: z.string().nullable(),
              requires: z.array(z.string()),
              socket: z.string().nullable(),
            }),
          ),
        )
        .query(() =>
          notify.channelStatus().map((s) => ({
            channel: s.channel,
            configured: s.configured,
            available: s.available,
            reason: s.reason,
            requires: [...s.requires],
            socket: s.socket,
          })),
        ),

      targets: scopedProcedure('notify:read', { module: 'notify' })
        .output(z.array(targetOutput))
        .query(async ({ ctx }) => {
          const targets = await notify.listTargets(ctx.principal.userId);
          return targets
            .filter((t) => t.channel !== 'inapp')
            .map((t) => ({
              channel: t.channel as 'email' | 'push' | 'sms',
              address: t.address,
              locale: t.locale,
              verifiedAt: t.verifiedAt?.toISOString() ?? null,
            }));
        }),

      /**
       * Register an address and send it a confirmation code.
       *
       * The outcome is reported, never smoothed over. `refused` with
       * `channel.not_configured` means the owner has not obtained credentials
       * for this channel and the address will stay unconfirmed — the truth, and
       * infinitely better than a green tick over silence.
       */
      registerTarget: scopedProcedure('notify:write', { module: 'notify' })
        .input(registerInput)
        .output(
          z.object({
            status: z.enum(['sent', 'refused', 'failed']),
            channel: outOfAppChannelSchema,
            code: z.string().nullable(),
            expiresAt: z.string(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            const outcome = await notify.registerTarget({
              userId: ctx.principal.userId,
              channel: input.channel,
              address: input.address,
              locale: input.locale ?? 'en',
            });
            return {
              status: outcome.status,
              channel: outcome.channel,
              code: outcome.status === 'refused' ? outcome.code : null,
              expiresAt: outcome.expiresAt.toISOString(),
            };
          } catch (err) {
            if (err instanceof NotifyVerifyTtlUnsetError || err instanceof NotifyVerifyCodePepperUnsetError) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: err.message,
                cause: err,
              });
            }
            throw err;
          }
        }),

      /**
       * Confirm an address. Wrong, expired and already-spent codes are one
       * answer (`verified: false`, `code: null`). Rate limit is a named refuse
       * code so the client can render "try later" without inventing copy.
       */
      verifyTarget: scopedProcedure('notify:write', { module: 'notify' })
        .input(z.object({ channel: outOfAppChannelSchema, code: z.string().regex(/^\d{6}$/) }))
        .output(
          z.object({
            verified: z.boolean(),
            /** Set when the call was refused (rate limit). Null on success / wrong code. */
            code: z.string().nullable(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            const outcome = await notify.verifyTarget(ctx.principal.userId, input.channel, input.code);
            if (outcome.status === 'verified') return { verified: true, code: null };
            if (outcome.status === 'refused') return { verified: false, code: outcome.code };
            return { verified: false, code: null };
          } catch (err) {
            if (err instanceof NotifyVerifyCodePepperUnsetError) {
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
            }
            throw err;
          }
        }),

      removeTarget: scopedProcedure('notify:write', { module: 'notify' })
        .input(z.object({ channel: outOfAppChannelSchema }))
        .output(z.object({ removed: z.boolean() }))
        .mutation(async ({ ctx, input }) => ({
          removed: await notify.removeTarget(ctx.principal.userId, input.channel),
        })),

      /**
       * What actually happened to one of the caller's notifications, per channel.
       *
       * An id the caller does not own returns an empty list rather than an
       * error, because an error distinguishing "not yours" from "no such row"
       * tells a stranger which notification ids exist.
       */
      deliveries: scopedProcedure('notify:read', { module: 'notify' })
        .input(z.object({ notificationId: z.string().guid() }))
        .output(z.array(deliveryOutput))
        .query(async ({ ctx, input }) => (await notify.deliveriesFor(ctx.principal.userId, input.notificationId)).map(deliveryToWire)),

      /**
       * Operator delivery-outcomes view (`ops.notifications` residual).
       *
       * Cross-user newest-first. `admin:read` only — never `notify:read`, which
       * is self-scoped. `accepted` ≠ end-device delivered (mountain honesty).
       * Bound limit (max 200). Omit is not 50. Canonical door: `notify.ops.deliveries`.
       */
      operatorDeliveries: scopedProcedure('admin:read', { module: 'notify' })
        .input(operatorDeliveriesInput)
        .output(z.array(operatorDeliveryOutput))
        .query(async ({ input }) => loadOperatorDeliveries(notify, input?.limit, input?.status)),

      operatorDeliveryAggregates: scopedProcedure('admin:read', { module: 'notify' })
        .output(
          z.object({
            asOf: z.string(),
            total: z.number().int(),
            byStatus: z.object({
              pending: z.number().int(),
              accepted: z.number().int(),
              refused: z.number().int(),
              failed: z.number().int(),
              abandoned: z.number().int(),
            }),
            byChannel: z.record(z.string(), z.number().int()),
          }),
        )
        .query(async () => {
          try {
            return await notify.operatorDeliveryAggregates();
          } catch (err) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: err instanceof Error ? err.message : 'notify.delivery_store_unconfigured',
            });
          }
        }),

      operatorProviderHealth: scopedProcedure('admin:read', { module: 'notify' })
        .output(
          z.object({
            email: z.object({
              channel: z.literal('email'),
              configured: z.boolean(),
              probed: z.literal(false),
              code: z.string(),
              reason: z.string(),
            }),
            push: z.object({
              channel: z.literal('push'),
              configured: z.boolean(),
              probed: z.literal(false),
              code: z.string(),
              reason: z.string(),
            }),
            delivered: z.object({ observed: z.literal(false), code: z.literal('notify.delivered_unobserved'), reason: z.string() }),
          }),
        )
        .query(() => providerHealth(process.env)),

      /**
       * Recipients by state (active, unconfirmed, quarantined), addresses masked.
       * `thresholdCode` is `notify.quarantine_threshold_unset` until the owner sets
       * the count: nothing is quarantined meanwhile and the page says so. Page size
       * is owner-published like the deliveries list: omit refuses.
       */
      operatorRecipients: scopedProcedure('admin:read', { module: 'notify' })
        .input(
          z.object({
            state: z.enum(RECIPIENT_STATES as unknown as [string, ...string[]]),
            limit: z.number().int().min(1).max(200).optional(),
          }),
        )
        .output(
          z.object({
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
        )
        .query(async ({ input }) => {
          const r = await notify.operatorRecipients(input.state as 'active' | 'unconfirmed' | 'quarantined', input.limit);
          return {
            threshold: r.threshold,
            thresholdCode: r.thresholdCode,
            items: r.items.map((i) => ({
              ...i,
              lastFailureAt: i.lastFailureAt?.toISOString() ?? null,
              quarantinedAt: i.quarantinedAt?.toISOString() ?? null,
            })),
          };
        }),

      /** Lift a quarantine. Reason required; `reasonId` makes a replay a no-op; audited. */
      operatorReleaseRecipient: scopedProcedure('admin:write', { module: 'notify' })
        .input(
          z.object({
            userId: z.string().min(1).max(128),
            channel: outOfAppChannelSchema,
            reason: z.string().max(500),
            reasonId: z.string().min(1).max(128),
          }),
        )
        .output(z.object({ released: z.literal(true), replayed: z.boolean() }))
        .mutation(async ({ ctx, input }) => {
          try {
            return await notify.operatorReleaseRecipient(ctx.principal.userId, input);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      ops: router({
        deliveries: scopedProcedure('admin:read', { module: 'notify' })
          .input(operatorDeliveriesInput)
          .output(z.array(operatorDeliveryOutput))
          .query(async ({ input }) => loadOperatorDeliveries(notify, input?.limit, input?.status)),
      }),

      /** Out-of-app mute prefs. Critical severity never respects mute (dispatch law). */
      mutePrefs: scopedProcedure('notify:read', { module: 'notify' })
        .output(
          z.array(
            z.object({
              channel: z.enum(['email', 'push', 'sms']),
              muted: z.boolean(),
            }),
          ),
        )
        .query(async ({ ctx }) => notify.listMutePrefs(ctx.principal.userId)),

      setMute: scopedProcedure('notify:write', { module: 'notify' })
        .input(z.object({ channel: z.enum(['email', 'push', 'sms']), muted: z.boolean() }))
        .output(
          z.array(
            z.object({
              channel: z.enum(['email', 'push', 'sms']),
              muted: z.boolean(),
            }),
          ),
        )
        .mutation(async ({ ctx, input }) => {
          await notify.setChannelMute(ctx.principal.userId, input.channel, input.muted);
          return notify.listMutePrefs(ctx.principal.userId);
        }),

      /**
       * Per-topic out-of-app choices. Inbox is always enabled. Unset means enabled.
       * `configured` is the channel credential fact, not the person's choice.
       */
      topicPrefs: scopedProcedure('notify:read', { module: 'notify' })
        .output(z.array(topicPrefOutput))
        .query(async ({ ctx }) => {
          if (!notify.account) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.preferences_unavailable' });
          try {
            return [...(await notify.account.topicPrefs(ctx.principal.userId))];
          } catch (err) {
            typedRefusal(err);
          }
        }),

      setTopicPref: scopedProcedure('notify:write', { module: 'notify' })
        .input(
          z.object({
            topic: z.string().min(1).max(32),
            channel: z.string().min(1).max(16),
            enabled: z.boolean(),
            clientRequestId: z.string().min(1).max(128),
          }),
        )
        .output(z.array(topicPrefOutput))
        .mutation(async ({ ctx, input }) => {
          if (!notify.account) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.preferences_unavailable' });
          try {
            return [...(await notify.account.setTopicPref(ctx.principal.userId, input))];
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /**
       * The category-by-channel grid. `security` and the inbox are locked on.
       * `notConnected` names the delivery vendor a switched-off channel is missing.
       */
      categoryPrefs: scopedProcedure('notify:read', { module: 'notify' })
        .output(z.array(categoryPrefRowOutput))
        .query(async ({ ctx }) => {
          if (!notify.categories) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.preferences_unavailable' });
          return [...(await notify.categories.rows(ctx.principal.userId))];
        }),

      /** A write to a locked cell stores nothing and answers `locked: true`. */
      setCategoryPref: scopedProcedure('notify:write', { module: 'notify' })
        .input(
          z.object({
            category: z.string().min(1).max(32),
            channel: z.string().min(1).max(16),
            enabled: z.boolean(),
            clientRequestId: z.string().min(1).max(128),
          }),
        )
        .output(categoryPrefResultOutput)
        .mutation(async ({ ctx, input }) => {
          if (!notify.categories) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.preferences_unavailable' });
          try {
            const out = await notify.categories.set(ctx.principal.userId, input);
            return { rows: [...out.rows], locked: out.locked };
          } catch (err) {
            typedRefusal(err);
          }
        }),

      digestPrefs: scopedProcedure('notify:read', { module: 'notify' })
        .output(digestOutput)
        .query(async ({ ctx }) => {
          if (!notify.account) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.preferences_unavailable' });
          return notify.account.digestPrefs(ctx.principal.userId);
        }),

      setDigest: scopedProcedure('notify:write', { module: 'notify' })
        .input(
          z.object({
            mode: z.string().min(1).max(16),
            quietHours: z
              .object({
                start: z.string().max(8),
                end: z.string().max(8),
                timeZone: z.string().max(64),
              })
              .nullable()
              .optional(),
            clientRequestId: z.string().min(1).max(128),
          }),
        )
        .output(digestOutput)
        .mutation(async ({ ctx, input }) => {
          if (!notify.account) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.preferences_unavailable' });
          try {
            return await notify.account.setDigest(ctx.principal.userId, input);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /**
       * One page of this account's finished deliveries, newest first.
       * Limit above {@link RECENT_DELIVERIES_LIMIT_MAX} is clamped to that constant.
       */
      recentDeliveries: scopedProcedure('notify:read', { module: 'notify' })
        .input(
          z.object({
            limit: z.number().int().min(1),
            cursor: z.string().min(1).max(512).nullable().optional(),
          }),
        )
        .output(
          z.object({
            rows: z.array(recentDeliveryOutput),
            counts: z.object({
              sent: z.number().int().nonnegative(),
              refused: z.number().int().nonnegative(),
              failed: z.number().int().nonnegative(),
            }),
            nextCursor: z.string().nullable(),
          }),
        )
        .query(async ({ ctx, input }) => {
          try {
            return await notify.recentDeliveries(ctx.principal.userId, input.limit, input.cursor ?? null);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /** Published notices only. Signed-out callers can read this. Drafts are absent. */
      notices: publicProcedure
        .input(
          z.object({
            kind: z.enum(NOTICE_KINDS).optional(),
            limit: z.number().int().min(1),
            /** The id of the last notice of the page before: answers the page after it. */
            after: z.string().guid().optional(),
          }),
        )
        .output(z.array(noticeWireOutput))
        .query(async ({ input }) => {
          if (!notify.notices) return [];
          try {
            return [
              ...(await notify.notices.notices({
                kind: input.kind ?? null,
                limit: Math.min(input.limit, NOTICES_LIST_LIMIT_MAX),
                after: input.after ?? null,
              })),
            ];
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /**
       * Who a notice can be for: `everyone` (the public board) and each member audience, with whether its membership can
       * be read here. `p2p-merchants` is unavailable while P2P_URL is unset.
       */
      noticeAudiences: publicProcedure.output(z.array(z.object({ id: z.enum(NOTICE_AUDIENCES), available: z.boolean() }))).query(() => {
        if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
        return [...notify.notices.audiences()];
      }),

      /**
       * Open announcements for the member audiences the signed-in account is in (P2P merchants), newest first. Not one of
       * them: an empty list. Membership that cannot be read refuses `notify.notice_audience_unavailable`.
       */
      memberNotices: scopedProcedure('notify:read', { module: 'notify' })
        .input(z.object({ limit: z.number().int().min(1) }))
        .output(z.array(noticeWireOutput))
        .query(async ({ ctx, input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          try {
            return [...(await notify.notices.memberNotices(ctx.principal.userId, input))];
          } catch (err) {
            typedRefusal(err);
          }
        }),

      notice: publicProcedure
        .input(z.object({ id: z.string().guid() }))
        .output(noticeWireOutput)
        .query(async ({ input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notice_not_found' });
          try {
            return await notify.notices.notice(input.id);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /**
       * Published changelog entries, newest first, optionally one area or breaking
       * entries only. Signed-out. An entry with no release date reads `releaseOn: null`.
       */
      changelog: publicProcedure
        .input(
          z.object({
            area: changelogArea.optional(),
            breaking: z.boolean().optional(),
            limit: z.number().int().min(1),
          }),
        )
        .output(z.array(noticeWireOutput))
        .query(async ({ input }) => {
          if (!notify.notices) return [];
          try {
            return [
              ...(await notify.notices.changelog({ area: input.area ?? null, breaking: input.breaking ?? null, limit: input.limit })),
            ];
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /**
       * Advance notice. Breaking entries whose release date has not passed, soonest
       * first (an entry with no date is never listed), and every endpoint a published
       * entry retires. Signed-out.
       */
      upcomingChanges: publicProcedure
        .output(
          z.object({
            upcoming: z.array(noticeWireOutput),
            retired: z.array(
              z.object({ endpoint: z.string(), entryId: z.string().guid(), title: z.string(), releaseOn: changelogDay.nullable() }),
            ),
          }),
        )
        .query(async () => {
          if (!notify.notices) return { upcoming: [], retired: [] };
          const read = await notify.notices.upcomingChanges();
          return { upcoming: [...read.upcoming], retired: [...read.retired] };
        }),

      /** Open published incidents and maintenance windows. Signed-out. */
      noticeStatus: publicProcedure
        .output(
          z.object({
            incidents: z.array(noticeWireOutput),
            maintenance: z.array(noticeWireOutput),
          }),
        )
        .query(async () => {
          if (!notify.notices) return { incidents: [], maintenance: [] };
          const status = await notify.notices.noticeStatus();
          return { incidents: [...status.incidents], maintenance: [...status.maintenance] };
        }),

      /**
       * Open funding incidents and maintenance for one asset on one network, for
       * the deposit and withdraw banners. Signed-out. Another network of the same
       * asset is not included. Each incident carries its newest entry and phase.
       */
      fundingNotices: publicProcedure
        .input(z.object({ asset: noticeAsset, network: noticeNetwork }))
        .output(
          z.object({
            asset: z.string(),
            network: z.string(),
            incidents: z.array(z.object({ root: noticeWireOutput, latest: noticeWireOutput })),
            maintenance: z.array(noticeWireOutput),
          }),
        )
        .query(async ({ input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          try {
            const read = await notify.notices.fundingNotices(input);
            return { ...read, incidents: [...read.incidents], maintenance: [...read.maintenance] };
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /**
       * Machine-readable status. Signed-out. A component nothing measures reads
       * `unknown`. History is incident minutes per day with no uptime percentage.
       * `days` above the feed maximum is clamped to it.
       */
      statusFeed: publicProcedure
        .input(z.object({ days: z.number().int().min(1) }))
        .output(statusFeedOutput)
        .query(async ({ input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          return statusFeedOutput.parse(await notify.notices.statusFeed(input));
        }),

      draftNotice: scopedProcedure('admin:write', { module: 'notify' })
        .input(
          z.object({
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
            clientRequestId: z.string().min(1).max(128),
          }),
        )
        .output(noticeWireOutput)
        .mutation(async ({ ctx, input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          try {
            return await notify.notices.draft(ctx.principal.userId, input);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /**
       * The founders' notice desk: drafts and published notices, newest written first, with the incident fields and the
       * author. Drafts never leave this door; the signed-out reads list published rows only.
       */
      operatorNotices: scopedProcedure('admin:write', { module: 'notify' })
        .input(z.object({ kind: z.enum(NOTICE_KINDS).optional(), limit: z.number().int().min(1) }))
        .output(
          z.array(
            noticeWireOutput.extend({
              impact: statusImpact.nullable(),
              components: z.array(z.string()),
              parentId: z.string().guid().nullable(),
              resolves: z.boolean(),
              authorId: z.string(),
              createdAt: z.string(),
            }),
          ),
        )
        .query(async ({ input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          try {
            return (await notify.notices.operatorNotices({ kind: input.kind ?? null, limit: input.limit })).map((n) => ({
              ...n,
              components: [...n.components],
            }));
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /** What identity's approval for one draft's publish has to carry: action, target, version and payload hash. */
      noticeProposal: scopedProcedure('admin:write', { module: 'notify' })
        .input(z.object({ id: z.string().guid() }))
        .output(proposalOutput.extend({ actionType: z.literal('notify.notice.publish'), targetService: z.literal('svc-notify') }))
        .query(async ({ input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          try {
            return await notify.notices.publishProposal(input.id);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      publishNotice: scopedProcedure('admin:write', { module: 'notify' })
        .input(
          z.object({
            id: z.string().guid(),
            clientRequestId: z.string().min(1).max(128),
            approvalId: z.string().min(1).max(128),
            operationId: z.string().min(1).max(128),
          }),
        )
        .output(noticeWireOutput)
        .mutation(async ({ ctx, input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          try {
            return await notify.notices.publish(ctx.principal.userId, input);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /**
       * Owner channel settings (I-order-01). Whether each out-of-app channel has
       * credentials (never the credentials), the owner's on/off switch and the
       * adapter name. A channel with no credentials stays `unconfigured`: a switch
       * cannot make it send.
       */
      channelSettings: scopedProcedure('admin:read', { module: 'notify' })
        .output(z.array(channelSettingOutput))
        .query(async () => (notify.channelSettings ? [...(await notify.channelSettings.get())] : typedUnavailable('channel_settings'))),

      /** The hash, target and version the second person's approval has to carry for this exact change. */
      channelSettingProposal: scopedProcedure('admin:read', { module: 'notify' })
        .input(z.object({ channel: outOfAppChannelSchema, enabled: z.boolean(), adapter: z.string().max(64).nullable().optional() }))
        .output(proposalOutput)
        .query(async ({ input }) => {
          if (!notify.channelSettings) return typedUnavailable('channel_settings');
          try {
            return await notify.channelSettings.proposal(input);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /** Switch a channel and name its adapter. Needs an approval from a different person. */
      setChannelSettings: scopedProcedure('admin:write', { module: 'notify' })
        .input(
          z.object({
            channel: outOfAppChannelSchema,
            enabled: z.boolean(),
            adapter: z.string().max(64).nullable().optional(),
            ...approvalInput,
          }),
        )
        .output(channelSettingOutput)
        .mutation(async ({ ctx, input }) => {
          if (!notify.channelSettings) return typedUnavailable('channel_settings');
          try {
            return await notify.channelSettings.set(ctx.principal.userId, input);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /**
       * Genuine-communication policy (BK-safe-02): official domains, the never-ask
       * statement, our contact channels, SMS links and where to report phishing.
       * Signed-out. Before the owner publishes one it reads `not_published`.
       */
      contactPolicy: publicProcedure
        .output(contactPolicyOutput)
        .query(async () => (notify.contactPolicy ? await notify.contactPolicy.current() : typedUnavailable('contact_policy'))),

      contactPolicyProposal: scopedProcedure('admin:read', { module: 'notify' })
        .input(z.object(contactPolicyInput))
        .output(proposalOutput)
        .query(async ({ input }) => {
          if (!notify.contactPolicy) return typedUnavailable('contact_policy');
          try {
            return await notify.contactPolicy.proposal(input);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /** Publish a new version. Every field is required; needs an approval from a different person. */
      publishContactPolicy: scopedProcedure('admin:write', { module: 'notify' })
        .input(z.object({ ...contactPolicyInput, ...approvalInput }))
        .output(contactPolicyOutput)
        .mutation(async ({ ctx, input }) => {
          if (!notify.contactPolicy) return typedUnavailable('contact_policy');
          try {
            return await notify.contactPolicy.publish(ctx.principal.userId, input);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /** Identity message templates: the newest version of each key and the fields it may use. */
      templates: scopedProcedure('admin:read', { module: 'notify' })
        .output(z.array(templateOutput))
        .query(async () => (notify.templates ? [...(await notify.templates.list())] : typedUnavailable('templates'))),

      templateHistory: scopedProcedure('admin:read', { module: 'notify' })
        .input(z.object({ key: z.string().min(1).max(64) }))
        .output(
          z.array(
            z.object({
              version: z.number().int().positive(),
              subject: z.string(),
              body: z.string(),
              authorId: z.string(),
              createdAt: z.string(),
            }),
          ),
        )
        .query(async ({ input }) => {
          if (!notify.templates) return typedUnavailable('templates');
          try {
            return (await notify.templates.history(input.key)).map((r) => ({
              version: r.version,
              subject: r.subject,
              body: r.body,
              authorId: r.authorId,
              createdAt: r.createdAt.toISOString(),
            }));
          } catch (err) {
            typedRefusal(err);
          }
        }),

      templateProposal: scopedProcedure('admin:read', { module: 'notify' })
        .input(z.object(templateCopyInput))
        .output(proposalOutput)
        .query(async ({ input }) => {
          if (!notify.templates) return typedUnavailable('templates');
          try {
            return await notify.templates.proposal(input);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /** Save a new version. Unknown fields are refused here; needs an approval from a different person. */
      setTemplate: scopedProcedure('admin:write', { module: 'notify' })
        .input(z.object({ ...templateCopyInput, ...approvalInput }))
        .output(templateOutput)
        .mutation(async ({ ctx, input }) => {
          if (!notify.templates) return typedUnavailable('templates');
          try {
            return await notify.templates.set(ctx.principal.userId, input);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /** Render a saved version with TEST sample values (and any values the caller supplies). */
      previewTemplate: scopedProcedure('admin:read', { module: 'notify' })
        .input(
          z.object({
            key: z.string().min(1).max(64),
            version: z.number().int().positive().optional(),
            values: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
          }),
        )
        .output(z.object({ sample: z.literal(true), version: z.number().int().positive(), subject: z.string(), body: z.string() }))
        .query(async ({ input }) => {
          if (!notify.templates) return typedUnavailable('templates');
          try {
            return await notify.templates.preview(input);
          } catch (err) {
            typedRefusal(err);
          }
        }),

      /** Send the newest version, filled with TEST values, to the caller's own confirmed address. There is no address field. */
      testSendTemplate: scopedProcedure('admin:write', { module: 'notify' })
        .input(z.object({ key: z.string().min(1).max(64), channel: outOfAppChannelSchema, clientRequestId: z.string().min(1).max(128) }))
        .output(
          z.object({
            status: z.enum(['accepted', 'refused', 'failed']),
            code: z.string().nullable(),
            version: z.number().int().positive(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          if (!notify.templates) return typedUnavailable('templates');
          try {
            return await notify.templates.testSend(ctx.principal.userId, input);
          } catch (err) {
            typedRefusal(err);
          }
        }),

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
      alerts: scopedProcedure('notify:read', { module: 'notify' })
        .input(
          z
            .object({
              /**
               * Page size. Optional here so omit reaches the named refuse
               * (`notify.alerts_list_limit_unset`) instead of a Zod "Required".
               * Blank is not 20; pass 20 explicitly when that is the page you want.
               */
              limit: z.number().int().min(1).max(100).optional(),
            })
            .optional(),
        )
        .output(z.object({ items: z.array(priceAlertOutput), evaluation: alertEvaluationOutput }))
        .query(async ({ ctx, input }) => {
          try {
            const limit = assertNotifyAlertsListLimit(input?.limit);
            if (!alerts) return { items: [], evaluation: NO_ALERT_SERVICE };
            return {
              items: (await alerts.list(ctx.principal.userId, limit)).map(priceAlertToWire),
              evaluation: alerts.evaluationStatus(),
            };
          } catch (err) {
            if (err instanceof NotifyAlertsListLimitUnsetError) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: err.message,
                cause: err,
              });
            }
            throw err;
          }
        }),

      createAlert: scopedProcedure('notify:write', { module: 'notify' })
        .input(
          z.union([
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
        )
        // The watch AND whether it can fire, in the same answer. A create that
        // returned only `status: 'active'` is what let this surface promise
        // delivery it had no path for.
        .output(z.object({ alert: priceAlertOutput, evaluation: alertEvaluationOutput }))
        .mutation(async ({ ctx, input }) => {
          if (!alerts) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'alert.price_unavailable',
            });
          }
          if (isUnpublishedAlertKind(input.kind)) {
            try {
              alerts.createUnpublishedKind({ kind: input.kind, userId: ctx.principal.userId });
            } catch (err) {
              if (err instanceof AlertKindUnpublishedError) {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message: err.message,
                  cause: err,
                });
              }
              throw err;
            }
          }
          if (input.kind === 'portfolio') {
            try {
              alerts.createPortfolio({ kind: 'portfolio', userId: ctx.principal.userId });
            } catch (err) {
              if (err instanceof AlertPortfolioUnpublishedError) {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message: err.message,
                  cause: err,
                });
              }
              throw err;
            }
          }
          const priceAlert =
            (input.kind === undefined || input.kind === 'price') &&
            'marketId' in input &&
            input.marketId !== undefined &&
            'direction' in input &&
            input.direction !== undefined;
          const refuseUnpublishedPortfolio: () => never = () => {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'alert.portfolio_view_unpublished: ledger portfolio view unpublished — notify holds no balance',
            });
          };
          if (
            !priceAlert &&
            (!('marketId' in input) || input.marketId === undefined || input.direction === undefined || input.targetPrice === undefined)
          ) {
            refuseUnpublishedPortfolio();
          }
          if (!('marketId' in input) || input.marketId === undefined || input.direction === undefined) {
            refuseUnpublishedPortfolio();
          }
          const kind = priceAlert ? 'price' : input.kind;
          if (!isSourcedAlertKind(kind)) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `alert.kind_unpublished: ${String(kind)} has no sourced series`,
            });
          }
          try {
            const extras = input as {
              condition?: AlertCondition;
              name?: string;
              message?: string;
              expiresAt?: string;
              extras?: AlertExtra[];
              frequency?: AlertFrequency;
            };
            const condition = extras.condition;
            // A named condition and a direction that disagree is a bad request, never a guess. `crossing` has no direction.
            if (condition && condition !== 'crossing' && directionOfCondition(condition) !== input.direction) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'alert.invalid_direction: condition and direction disagree' });
            }
            const row = await alerts.create({
              userId: ctx.principal.userId,
              marketId: input.marketId,
              kind,
              direction: input.direction,
              targetPrice: 'targetPrice' in input ? input.targetPrice : undefined,
              ...(condition ? { condition } : {}),
              name: extras.name,
              message: extras.message,
              expiresAt: extras.expiresAt ? new Date(extras.expiresAt) : undefined,
              ...(extras.extras ? { extras: extras.extras } : {}),
              ...(extras.frequency ? { frequency: extras.frequency } : {}),
            });
            return {
              alert: priceAlertToWire(row),
              evaluation: kind === 'whale' ? alerts.whaleEvaluationStatus() : alerts.evaluationStatus(),
            };
          } catch (err) {
            if (err instanceof NotifyPriceUnsetError) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: err.message,
                cause: err,
              });
            }
            if (err instanceof AlertLimitError) {
              throw new TRPCError({
                // A blank owner setting is a precondition; a value outside a set one is the caller's to fix.
                code: err.code.startsWith('notify.') || err.code === 'alert.quota_reached' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST',
                message: err.message,
                cause: err,
              });
            }
            throw err;
          }
        }),

      /**
       * A watchlist alert: the same price rule on each market named, one alert per market, all or none. Held to the price-alert
       * quota as a whole (a batch that would pass it creates nothing), and checked like a single create in every other way.
       */
      createAlerts: scopedProcedure('notify:write', { module: 'notify' })
        .input(
          z.object({
            marketIds: z.array(z.string().min(1).max(64)).min(1).max(100),
            direction: z.enum(['above', 'below']),
            /** Decimal string. Optional so a blank price reaches `notify.price_unset` instead of a Zod "Required". */
            targetPrice: z.string().max(64).optional(),
            ...alertExtras,
          }),
        )
        .output(z.object({ alerts: z.array(priceAlertOutput).min(1), evaluation: alertEvaluationOutput }))
        .mutation(async ({ ctx, input }) => {
          if (!alerts) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'alert.price_unavailable' });
          if (input.condition && input.condition !== 'crossing' && directionOfCondition(input.condition) !== input.direction) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'alert.invalid_direction: condition and direction disagree' });
          }
          try {
            const rows = await alerts.createMany({
              userId: ctx.principal.userId,
              marketIds: input.marketIds,
              direction: input.direction,
              targetPrice: input.targetPrice,
              ...(input.condition ? { condition: input.condition } : {}),
              name: input.name,
              message: input.message,
              expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
              ...(input.extras ? { extras: input.extras } : {}),
              ...(input.frequency ? { frequency: input.frequency } : {}),
            });
            return { alerts: rows.map(priceAlertToWire), evaluation: alerts.evaluationStatus() };
          } catch (err) {
            if (err instanceof AlertValidationError) throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
            throw alertManagerError(err);
          }
        }),

      cancelAlert: scopedProcedure('notify:write', { module: 'notify' })
        .input(z.object({ id: z.string().guid() }))
        .output(z.object({ cancelled: z.boolean(), alert: priceAlertOutput.nullable() }))
        .mutation(async ({ ctx, input }) => {
          if (!alerts) return { cancelled: false, alert: null };
          const row = await alerts.cancel(ctx.principal.userId, input.id);
          if (!row) return { cancelled: false, alert: null };
          return { cancelled: row.status === 'cancelled', alert: priceAlertToWire(row) };
        }),

      /**
       * Change an alert that is active or stopped. Only what is sent changes; `null` clears a name, message or expiry. Checked as a
       * create is: a blank owner setting refuses, a value outside a set one is a bad request. Nothing is written on a refusal.
       */
      updateAlert: scopedProcedure('notify:write', { module: 'notify' })
        .input(
          z.object({
            id: z.string().guid(),
            targetPrice: z.string().min(1).max(64).optional(),
            condition: z.enum(ALERT_CONDITIONS).optional(),
            name: z.string().max(2000).nullable().optional(),
            message: z.string().max(2000).nullable().optional(),
            expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
            extras: alertExtras.extras,
            frequency: alertExtras.frequency,
          }),
        )
        .output(z.object({ alert: priceAlertOutput }))
        .mutation(async ({ ctx, input }) => {
          if (!alerts) throw new TRPCError({ code: 'NOT_FOUND', message: 'alert.not_found' });
          try {
            const row = await alerts.edit(ctx.principal.userId, input.id, {
              ...(input.targetPrice !== undefined ? { targetPrice: input.targetPrice } : {}),
              ...(input.condition ? { condition: input.condition } : {}),
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.message !== undefined ? { message: input.message } : {}),
              ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt) } : {}),
              ...(input.extras !== undefined ? { extras: input.extras } : {}),
              ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
            });
            if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'alert.not_found' });
            return { alert: priceAlertToWire(row) };
          } catch (err) {
            throw alertManagerError(err);
          }
        }),

      /** Pause (`active: false`) an active alert or resume a stopped one. Repeating it is harmless: the alert is returned as it is. */
      setAlertActive: scopedProcedure('notify:write', { module: 'notify' })
        .input(z.object({ id: z.string().guid(), active: z.boolean() }))
        .output(z.object({ changed: z.boolean(), alert: priceAlertOutput }))
        .mutation(async ({ ctx, input }) => {
          if (!alerts) throw new TRPCError({ code: 'NOT_FOUND', message: 'alert.not_found' });
          try {
            const before = await alerts.get(ctx.principal.userId, input.id);
            const row = await alerts.setActive(ctx.principal.userId, input.id, input.active);
            if (!row || !before) throw new TRPCError({ code: 'NOT_FOUND', message: 'alert.not_found' });
            return { changed: row.status !== before.status, alert: priceAlertToWire(row) };
          } catch (err) {
            throw alertManagerError(err);
          }
        }),

      /** How many price alerts the person holds open and the cap the owner set. `max: null` is a blank setting: creates refuse. */
      alertQuota: scopedProcedure('notify:read', { module: 'notify' })
        .output(
          z.object({
            kind: z.literal('price'),
            used: z.number().int().min(0),
            max: z.number().int().min(1).nullable(),
            /** The burst auto-stop rule, or null while the owner has not set it (the rule is off). */
            burst: z.object({ windowMinutes: z.number().int().min(1), maxTriggers: z.number().int().min(1) }).nullable(),
          }),
        )
        .query(async ({ ctx }) => {
          if (!alerts) return { kind: 'price' as const, used: 0, max: null, burst: null };
          return alerts.quota(ctx.principal.userId);
        }),

      /**
       * The person's trigger log: each time an alert fired and the mark that fired it, newest first. The owner sets how long
       * rows are kept; blank refuses `notify.alert_trigger_log_retention_unset` rather than answering an empty list.
       */
      alertTriggers: scopedProcedure('notify:read', { module: 'notify' })
        .input(z.object({ alertId: z.string().guid().optional(), limit: z.number().int().min(1).max(200) }))
        .output(
          z.object({
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
              }),
            ),
          }),
        )
        .query(async ({ ctx, input }) => {
          if (!alerts) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: NOTIFY_ALERT_TRIGGER_LOG_RETENTION_UNSET });
          try {
            const log = await alerts.triggers(ctx.principal.userId, {
              ...(input.alertId ? { alertId: input.alertId } : {}),
              limit: input.limit,
            });
            return {
              retentionDays: log.retentionDays,
              items: log.triggers.map((t) => ({
                alertId: t.alertId,
                seq: t.seq,
                marketId: t.marketId,
                condition: t.condition,
                targetPrice: t.targetPrice,
                markPrice: t.markPrice,
                firedAt: t.firedAt.toISOString(),
                notificationId: t.notificationId,
              })),
            };
          } catch (err) {
            throw alertManagerError(err);
          }
        }),

      /** Delete an alert whatever its state. Deleting one that is already gone answers `deleted: false`. */
      deleteAlert: scopedProcedure('notify:write', { module: 'notify' })
        .input(z.object({ id: z.string().guid() }))
        .output(z.object({ deleted: z.boolean() }))
        .mutation(async ({ ctx, input }) => {
          if (!alerts) return { deleted: false };
          return { deleted: await alerts.remove(ctx.principal.userId, input.id) };
        }),

      /**
       * Condition eval against the sourced mark. Dark / missing MarkSource
       * refuses `alert.price_unavailable` and never returns fired as live.
       */
      evaluateAlert: scopedProcedure('notify:write', { module: 'notify' })
        .input(
          z.union([
            z.object({ id: z.string().guid() }),
            z.object({ kind: z.enum(UNPUBLISHED_ALERT_KINDS) }),
            z.object({ kind: z.literal('portfolio') }),
          ]),
        )
        .output(
          z.object({
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
        )
        .mutation(async ({ ctx, input }) => {
          if (!alerts) {
            return {
              alert: null,
              outcome: {
                kind: 'refuse' as const,
                code: 'alert.price_unavailable' as const,
                detail: 'mark source missing',
              },
              evaluation: NO_ALERT_SERVICE,
            };
          }
          if ('kind' in input && input.kind === 'portfolio') {
            return {
              alert: null,
              outcome: alerts.evaluatePortfolio(),
              evaluation: alerts.evaluationStatus(),
            };
          }
          if ('kind' in input && isUnpublishedAlertKind(input.kind)) {
            const outcome = alerts.evaluateUnpublishedKind(input.kind);
            return {
              alert: null,
              outcome,
              evaluation: alerts.evaluationStatus(),
            };
          }
          if (!('id' in input)) {
            return {
              alert: null,
              outcome: {
                kind: 'refuse' as const,
                code: 'alert.kind_unpublished' as const,
                detail: 'unpublished kind has no sourced series',
              },
              evaluation: alerts.evaluationStatus(),
            };
          }
          const report = await alerts.evaluateAlert(ctx.principal.userId, input.id);
          return {
            alert: report.alert ? priceAlertToWire(report.alert) : null,
            outcome: report.outcome,
            evaluation: report.evaluation,
          };
        }),
    }),
  });
}

export type NotifyRouter = ReturnType<typeof createNotifyRouter>;
