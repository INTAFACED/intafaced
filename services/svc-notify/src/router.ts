import { z } from 'zod';
import {
  ALERT_OWNER_KEYS,
  AlertOwnerValueError,
  NOTIFY_OWNER_VALUE_FORBIDDEN,
  NOTIFY_OWNER_VALUE_STALE,
  PLAN_ID,
  type AlertOwnerValues,
} from './alerts/owner-values.js';
import { guestNotificationsRouter } from './guests/router.js';
import { guestVerificationRouter } from './guests/verification-router.js';
import { supportChartsRouter } from './alerts/support-charts-router.js';
import { statusPageRouter, type StatusPageDeps } from './status-page/router.js';
import { navMetricsRouter } from './nav-metrics/router.js';
import { reconAlertFeedRouter } from './reconciliation-alert-feed/router.js';
import { MemoryReconAlertFeedStore, type ReconAlertFeedStore } from './reconciliation-alert-feed/feed.js';
import type { NavMetricStore } from './nav-metrics/counts.js';
import type { GuestNotificationService } from './guests/service.js';
import type { GuestVerificationService } from './guests/verification.js';
import { router, publicProcedure, scopedProcedure, TRPCError, marketMaintenanceReadSchema } from '@intafaced/contracts';
import {
  NotifyAnnouncementUnsetError,
  NotifyListLimitUnsetError,
  NotifyOperatorDeliveriesLimitUnsetError,
  assertNotifyListLimit,
  readPublicAnnouncement,
  type NotifyService,
} from './notify-service.js';
import type { DeliveryRecord } from './channel-store.js';
import { providerHealth } from './provider-health.js';
import type { Notification } from './store.js';
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
import { AlertWebhookError, NO_WEBHOOK_POLICY } from './alerts/webhook.js';
import { WatchRuleError, type WatchRule, type WatchRuleService } from './alerts/watch-rules.js';
import {
  type AlertOutChannel,
  AlertKindUnpublishedError,
  type AlertCondition,
  type AlertExtra,
  type AlertFrequency,
  type AlertPriceSource,
  AlertPortfolioUnpublishedError,
  directionOfCondition,
  isSourcedAlertKind,
  isUnpublishedAlertKind,
  type PriceAlert,
} from './alerts/types.js';
import { describeChannelsPolicy } from './channels-policy.js';
import { pushKeyPolicy } from './push-key.js';
import { NOTIFY_INBOX_POLICY } from '@intafaced/contracts/notify-inbox-policy';
import {
  NOTIFY_CHANNELS,
  NOTIFY_DELIVERIES,
  NOTIFY_MARK_ALL_READ,
  NOTIFY_MARK_READ,
  NOTIFY_PUSH_KEY,
  NOTIFY_REGISTER_TARGET,
  NOTIFY_REMOVE_TARGET,
  NOTIFY_TARGETS,
  NOTIFY_UNREAD_COUNT,
  NOTIFY_VERIFY_TARGET,
} from '@intafaced/contracts/notify-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { notifyRefusal } from './record-refusal.js';
import { BLANK_INBOX_SETTINGS, describeInboxPolicy, type InboxSettings } from './inbox-policy.js';
import { describeAlertsPolicy } from './alerts-policy.js';
import { UNWIRED_VENUE_INCIDENT, resolveVenueIncident, type VenueIncidentLoader } from './venue-incident-truth.js';
import { PreferenceError } from './preferences/account.js';
import { CategoryPrefError } from './preferences/categories.js';
import { QuietHoursError } from './preferences/quiet-hours.js';
import { RecentDeliveriesError } from './preferences/recent.js';
import { NoticeError, NOTICES_LIST_LIMIT_MAX } from './notices/board.js';
import { OpsConfigError } from './ops-config/four-eyes.js';
import { RecipientHealthError } from './recipient-health.js';
import { CONTACT_CHANNELS } from './ops-config/contact-policy.js';
import {
  outOfAppChannelSchema,
  channelSettingOutput,
  templateOutput,
  noticeWireOutput,
  proposalOutput,
  operatorDeliveriesInput,
  channelSchema,
  operatorDeliveryOutput,
  statusFeedOutput,
} from '@intafaced/contracts/notify-call-schemas';
import {
  NOTIFY_CHANNEL_SETTINGS,
  NOTIFY_TEMPLATES,
  NOTIFY_OPERATOR_NOTICES,
  NOTIFY_DRAFT_NOTICE,
  NOTIFY_NOTICE_PROPOSAL,
  NOTIFY_PUBLISH_NOTICE,
  NOTIFY_NOTICE_AUDIENCES,
  NOTIFY_OPERATOR_RECIPIENTS,
  NOTIFY_OPERATOR_RELEASE_RECIPIENT,
  NOTIFY_OPERATOR_DELIVERIES,
  NOTIFY_NOTICES,
  NOTIFY_MUTE_PREFS,
  NOTIFY_SET_MUTE,
  NOTIFY_FUNDING_NOTICES,
  NOTIFY_NOTICE,
  NOTIFY_NOTICE_STATUS,
  NOTIFY_ALERTS,
  NOTIFY_CREATE_ALERT,
  NOTIFY_CANCEL_ALERT,
  NOTIFY_EVALUATE_ALERT,
  NOTIFY_CATEGORY_PREFS,
  NOTIFY_SET_CATEGORY_PREF,
  NOTIFY_UPDATE_ALERT,
  NOTIFY_SET_ALERT_ACTIVE,
  NOTIFY_DELETE_ALERT,
  NOTIFY_ALERT_WEBHOOK_POLICY,
  NOTIFY_ALERT_TRIGGERS,
  NOTIFY_ALERT_QUOTA,
  NOTIFY_CREATE_ALERTS,
  NOTIFY_WATCHLIST_ALERTS,
  NOTIFY_CREATE_WATCHLIST_ALERT,
  NOTIFY_STOP_WATCHLIST_ALERT,
  NOTIFY_STATUS_FEED,
  NOTIFY_CHANGELOG,
  NOTIFY_UPCOMING_CHANGES,
  NOTIFY_LIST,
} from '@intafaced/contracts/notify-notify-procedures';
import { NOTIFY_HEALTH } from '@intafaced/contracts/notify-health-procedures';

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

const approvalInput = {
  clientRequestId: z.string().min(1).max(128),
  approvalId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
};

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

const typedUnavailable = (what: string): never => {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `notify.${what}_unavailable` });
};

const topicPrefOutput = z.object({
  topic: z.enum(['trade', 'p2p', 'identity', 'bank', 'token', 'agents']),
  channel: channelSchema,
  enabled: z.boolean(),
  configured: z.boolean(),
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

/** The answer when this deployment has no alert service at all. */
const NO_ALERT_SERVICE = { markSource: 'dark', canFire: false, code: 'alert.price_unavailable' } as const;

/** The refusals an edit or pause can raise, as tRPC errors. Anything else is not ours to hide. */
function alertManagerError(err: unknown): unknown {
  if (err instanceof TRPCError) return err;
  // A value the caller sent that the alert cannot hold (a side on a kind that watches the mark): theirs to fix, named by code.
  if (err instanceof AlertValidationError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `${err.code}: ${err.message}`, cause: err });
  }
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

function watchRuleToWire(row: WatchRule) {
  return {
    id: row.id,
    listId: row.listId,
    listName: row.listName,
    condition: row.condition,
    targetPrice: row.targetPrice,
    status: row.status,
    markets: [...row.markets],
    createdAt: row.createdAt.toISOString(),
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastSyncCode: row.lastSyncCode,
  };
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
    source: row.source,
    fireCount: row.fireCount,
    stopReason: row.stopReason,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    channels: row.channels ? [...row.channels] : null,
    webhookUrl: row.webhookUrl,
  };
}

/**
 * @param alerts Optional v22.alerts MVP service. When absent, alert procedures
 * refuse with a clear shape rather than inventing a silent empty list that
 * pretends the feature is live.
 * @param loadVenueIncident Matching halt / incident-silence truth. Default is
 * unwired — `ok` is process liveness, never an invented all-clear.
 */
/** The owner values store, or a typed refusal while this process has none wired. */
function ownerValuesOrRefuse(alerts: AlertService | undefined): AlertOwnerValues {
  const values = alerts?.ownerValuesStore();
  if (!values) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.alert_owner_values_unwired' });
  return values;
}

export function createNotifyRouter(
  notify: NotifyService,
  alerts?: AlertService,
  loadVenueIncident?: VenueIncidentLoader,
  guests?: GuestNotificationService,
  inbox: InboxSettings = BLANK_INBOX_SETTINGS,
  statusPage?: StatusPageDeps,
  navMetrics?: NavMetricStore,
  verifications?: GuestVerificationService,
  watchRules?: WatchRuleService,
  reconAlertFeed: { store: ReconAlertFeedStore; attached: () => boolean } = {
    store: new MemoryReconAlertFeedStore(),
    attached: () => false,
  },
) {
  return router({
    reconciliationAlertFeed: reconAlertFeedRouter(reconAlertFeed.store, reconAlertFeed.attached),
    guestNotifications: guestNotificationsRouter(guests),
    guestVerification: guestVerificationRouter(verifications),
    supportCharts: supportChartsRouter(alerts),
    navMetrics: navMetricsRouter(navMetrics),
    statusPage: statusPageRouter(statusPage),
    health: mountRecord(
      NOTIFY_HEALTH,
      async () => ({
        ok: true,
        service: 'svc-notify' as const,
        fanoutEnabled: notify.fanoutEnabled,
        venueIncident: await resolveVenueIncident(loadVenueIncident ?? (() => UNWIRED_VENUE_INCIDENT)),
      }),
      notifyRefusal,
    ),

    notify: router({
      list: mountRecord(
        NOTIFY_LIST,
        async ({ ctx, input }) => {
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
        },
        notifyRefusal,
      ),

      unreadCount: mountRecord(
        NOTIFY_UNREAD_COUNT,
        async ({ ctx }) => ({ count: await notify.unreadCount(ctx.principal.userId) }),
        notifyRefusal,
      ),

      markRead: mountRecord(
        NOTIFY_MARK_READ,
        async ({ ctx, input }) => ({ marked: await notify.markRead(ctx.principal.userId, input.ids) }),
        notifyRefusal,
      ),

      markAllRead: mountRecord(
        NOTIFY_MARK_ALL_READ,
        async ({ ctx }) => ({ marked: await notify.markAllRead(ctx.principal.userId) }),
        notifyRefusal,
      ),

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
      pushKey: mountRecord(NOTIFY_PUSH_KEY, () => pushKeyPolicy(process.env), notifyRefusal),

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
      // Its answer is the record's; any input is still taken as before (the wire replay holds that), since the call reads none.
      inboxPolicy: publicProcedure.output(NOTIFY_INBOX_POLICY.output).query(() => describeInboxPolicy(inbox)),

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
      channels: mountRecord(
        NOTIFY_CHANNELS,
        () =>
          notify.channelStatus().map((s) => ({
            channel: s.channel,
            configured: s.configured,
            available: s.available,
            reason: s.reason,
            requires: [...s.requires],
            socket: s.socket,
          })),
        notifyRefusal,
      ),

      targets: mountRecord(
        NOTIFY_TARGETS,
        async ({ ctx }) => {
          const targets = await notify.listTargets(ctx.principal.userId);
          return targets.flatMap((t) =>
            t.channel === 'inapp'
              ? []
              : [{ channel: t.channel, address: t.address, locale: t.locale, verifiedAt: t.verifiedAt?.toISOString() ?? null }],
          );
        },
        notifyRefusal,
      ),

      /**
       * Register an address and send it a confirmation code.
       *
       * The outcome is reported, never smoothed over. `refused` with
       * `channel.not_configured` means the owner has not obtained credentials
       * for this channel and the address will stay unconfirmed — the truth, and
       * infinitely better than a green tick over silence.
       */
      registerTarget: mountRecord(
        NOTIFY_REGISTER_TARGET,
        async ({ ctx, input }) => {
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
        },
        notifyRefusal,
      ),

      /**
       * Confirm an address. Wrong, expired and already-spent codes are one
       * answer (`verified: false`, `code: null`). Rate limit is a named refuse
       * code so the client can render "try later" without inventing copy.
       */
      verifyTarget: mountRecord(
        NOTIFY_VERIFY_TARGET,
        async ({ ctx, input }) => {
          const outcome = await notify.verifyTarget(ctx.principal.userId, input.channel, input.code);
          if (outcome.status === 'verified') return { verified: true, code: null };
          if (outcome.status === 'refused') return { verified: false, code: outcome.code };
          return { verified: false, code: null };
        },
        notifyRefusal,
      ),

      removeTarget: mountRecord(
        NOTIFY_REMOVE_TARGET,
        async ({ ctx, input }) => ({ removed: await notify.removeTarget(ctx.principal.userId, input.channel) }),
        notifyRefusal,
      ),

      /**
       * What actually happened to one of the caller's notifications, per channel.
       *
       * An id the caller does not own returns an empty list rather than an
       * error, because an error distinguishing "not yours" from "no such row"
       * tells a stranger which notification ids exist.
       */
      deliveries: mountRecord(
        NOTIFY_DELIVERIES,
        async ({ ctx, input }) => (await notify.deliveriesFor(ctx.principal.userId, input.notificationId)).map(deliveryToWire),
        notifyRefusal,
      ),

      /**
       * Operator delivery-outcomes view (`ops.notifications` residual).
       *
       * Cross-user newest-first. `admin:read` only — never `notify:read`, which
       * is self-scoped. `accepted` ≠ end-device delivered (mountain honesty).
       * Bound limit (max 200). Omit is not 50. Canonical door: `notify.ops.deliveries`.
       */
      operatorDeliveries: mountRecord(
        NOTIFY_OPERATOR_DELIVERIES,
        async ({ input }) => loadOperatorDeliveries(notify, input?.limit, input?.status),
        notifyRefusal,
      ),

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

      /**
       * Alert engine and delivery health (C-ops-01; J-charts-desk-18 #3 #4), `admin:read` only: the sweep's last pass and
       * its lag, firings today by kind, alert deliveries today by channel and status, and the open alert count. Read only.
       */
      opsAlertEngineHealth: scopedProcedure('admin:read', { module: 'notify' }).query(async () => {
        if (!alerts) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.alert_ops_unwired' });
        try {
          return await alerts.opsHealth();
        } catch (err) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: err instanceof Error ? err.message : 'notify.alert_ops_unwired',
          });
        }
      }),

      /**
       * The alert owner values (J-charts-desk-18 #5 #6): the price-alert quota per plan and the trigger-log retention, where
       * each comes from, who set it and when. `get` is admin:read; `set` is admin:write, one value per write with a reason.
       */
      opsAlertOwnerValues: router({
        get: scopedProcedure('admin:read', { module: 'notify' }).query(async ({ ctx }) => ownerValuesOrRefuse(alerts).get(ctx.principal)),
        set: scopedProcedure('admin:write', { module: 'notify' })
          .input(
            z
              .object({
                key: z.enum(ALERT_OWNER_KEYS),
                plan: z.string().regex(PLAN_ID).nullable().optional(),
                value: z.number().int().nullable(),
                expectedVersion: z.string().regex(/^(?:0|[1-9]\d*)$/),
                reason: z.string().max(500),
                clientRequestId: z.string().trim().min(1).max(160),
              })
              .strict(),
          )
          .mutation(async ({ ctx, input }) => {
            try {
              return await ownerValuesOrRefuse(alerts).set(ctx.principal, input);
            } catch (err) {
              if (err instanceof AlertOwnerValueError) {
                throw new TRPCError({
                  code:
                    err.code === NOTIFY_OWNER_VALUE_FORBIDDEN
                      ? 'FORBIDDEN'
                      : err.code === NOTIFY_OWNER_VALUE_STALE
                        ? 'CONFLICT'
                        : 'BAD_REQUEST',
                  message: `${err.code}: ${err.message}`,
                });
              }
              throw err;
            }
          }),
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
      operatorRecipients: mountRecord(
        NOTIFY_OPERATOR_RECIPIENTS,
        async ({ input }) => {
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
        },
        notifyRefusal,
      ),

      /** Lift a quarantine. Reason required; `reasonId` makes a replay a no-op; audited. */
      operatorReleaseRecipient: mountRecord(
        NOTIFY_OPERATOR_RELEASE_RECIPIENT,
        async ({ ctx, input }) => {
          try {
            return await notify.operatorReleaseRecipient(ctx.principal.userId, input);
          } catch (err) {
            typedRefusal(err);
          }
        },
        notifyRefusal,
      ),

      ops: router({
        deliveries: scopedProcedure('admin:read', { module: 'notify' })
          .input(operatorDeliveriesInput)
          .output(z.array(operatorDeliveryOutput))
          .query(async ({ input }) => loadOperatorDeliveries(notify, input?.limit, input?.status)),
      }),

      /** Out-of-app mute prefs. Critical severity never respects mute (dispatch law). */
      mutePrefs: mountRecord(NOTIFY_MUTE_PREFS, async ({ ctx }) => notify.listMutePrefs(ctx.principal.userId), notifyRefusal),

      setMute: mountRecord(
        NOTIFY_SET_MUTE,
        async ({ ctx, input }) => {
          await notify.setChannelMute(ctx.principal.userId, input.channel, input.muted);
          return notify.listMutePrefs(ctx.principal.userId);
        },
        notifyRefusal,
      ),

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
      categoryPrefs: mountRecord(
        NOTIFY_CATEGORY_PREFS,
        async ({ ctx }) => {
          if (!notify.categories) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.preferences_unavailable' });
          return [...(await notify.categories.rows(ctx.principal.userId))];
        },
        notifyRefusal,
      ),

      /** A write to a locked cell stores nothing and answers `locked: true`. */
      setCategoryPref: mountRecord(
        NOTIFY_SET_CATEGORY_PREF,
        async ({ ctx, input }) => {
          if (!notify.categories) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.preferences_unavailable' });
          try {
            const out = await notify.categories.set(ctx.principal.userId, input);
            return { rows: [...out.rows], locked: out.locked };
          } catch (err) {
            typedRefusal(err);
          }
        },
        notifyRefusal,
      ),

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
      notices: mountRecord(
        NOTIFY_NOTICES,
        async ({ input }) => {
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
        },
        notifyRefusal,
      ),

      /**
       * Who a notice can be for: `everyone` (the public board) and each member audience, with whether its membership can
       * be read here. `p2p-merchants` is unavailable while P2P_URL is unset.
       */
      noticeAudiences: mountRecord(
        NOTIFY_NOTICE_AUDIENCES,
        () => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          return [...notify.notices.audiences()];
        },
        notifyRefusal,
      ),

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

      notice: mountRecord(
        NOTIFY_NOTICE,
        async ({ input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notice_not_found' });
          try {
            return await notify.notices.notice(input.id);
          } catch (err) {
            typedRefusal(err);
          }
        },
        notifyRefusal,
      ),

      /**
       * Published changelog entries, newest first, optionally one area or breaking
       * entries only. Signed-out. An entry with no release date reads `releaseOn: null`.
       */
      changelog: mountRecord(
        NOTIFY_CHANGELOG,
        async ({ input }) => {
          if (!notify.notices) return [];
          try {
            return [
              ...(await notify.notices.changelog({
                area: input.area ?? null,
                breaking: input.breaking ?? null,
                limit: input.limit,
                language: input.language ?? null,
              })),
            ];
          } catch (err) {
            typedRefusal(err);
          }
        },
        notifyRefusal,
      ),

      /**
       * Advance notice. Breaking entries whose release date has not passed, soonest
       * first (an entry with no date is never listed), and every endpoint a published
       * entry retires. Signed-out.
       */
      upcomingChanges: mountRecord(
        NOTIFY_UPCOMING_CHANGES,
        async ({ input }) => {
          if (!notify.notices) return { upcoming: [], retired: [] };
          const read = await notify.notices.upcomingChanges(undefined, input?.language ?? null);
          return { upcoming: [...read.upcoming], retired: [...read.retired] };
        },
        notifyRefusal,
      ),

      /** Open published incidents and maintenance windows. Signed-out. */
      noticeStatus: mountRecord(
        NOTIFY_NOTICE_STATUS,
        async () => {
          if (!notify.notices) return { incidents: [], maintenance: [] };
          const status = await notify.notices.noticeStatus();
          return { incidents: [...status.incidents], maintenance: [...status.maintenance] };
        },
        notifyRefusal,
      ),

      /** Maintenance windows that name a market and have not ended, for svc-trade's lifecycle read (J-cex-spot-14 #5). Signed-out. */
      marketMaintenance: publicProcedure.output(marketMaintenanceReadSchema).query(async () => {
        // No board wired: refuse, so the lifecycle read says unavailable rather than claiming no maintenance.
        if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
        return notify.notices.marketMaintenance();
      }),

      /**
       * Open funding incidents and maintenance for one asset on one network, for
       * the deposit and withdraw banners. Signed-out. Another network of the same
       * asset is not included. Each incident carries its newest entry and phase.
       */
      fundingNotices: mountRecord(
        NOTIFY_FUNDING_NOTICES,
        async ({ input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          try {
            const read = await notify.notices.fundingNotices(input);
            return { ...read, incidents: [...read.incidents], maintenance: [...read.maintenance] };
          } catch (err) {
            typedRefusal(err);
          }
        },
        notifyRefusal,
      ),

      /**
       * Machine-readable status. Signed-out. A component nothing measures reads
       * `unknown`. History is incident minutes per day with no uptime percentage.
       * `days` above the feed maximum is clamped to it.
       */
      statusFeed: mountRecord(
        NOTIFY_STATUS_FEED,
        async ({ input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          return statusFeedOutput.parse(await notify.notices.statusFeed(input));
        },
        notifyRefusal,
      ),

      draftNotice: mountRecord(
        NOTIFY_DRAFT_NOTICE,
        async ({ ctx, input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          try {
            return await notify.notices.draft(ctx.principal.userId, input);
          } catch (err) {
            typedRefusal(err);
          }
        },
        notifyRefusal,
      ),

      /**
       * The founders' notice desk: drafts and published notices, newest written first, with the incident fields and the
       * author. Drafts never leave this door; the signed-out reads list published rows only.
       */
      operatorNotices: mountRecord(
        NOTIFY_OPERATOR_NOTICES,
        async ({ input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          try {
            return (await notify.notices.operatorNotices({ kind: input.kind ?? null, limit: input.limit })).map((n) => ({
              ...n,
              components: [...n.components],
            }));
          } catch (err) {
            typedRefusal(err);
          }
        },
        notifyRefusal,
      ),

      /** What identity's approval for one draft's publish has to carry: action, target, version and payload hash. */
      noticeProposal: mountRecord(
        NOTIFY_NOTICE_PROPOSAL,
        async ({ input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          try {
            return await notify.notices.publishProposal(input.id);
          } catch (err) {
            typedRefusal(err);
          }
        },
        notifyRefusal,
      ),

      publishNotice: mountRecord(
        NOTIFY_PUBLISH_NOTICE,
        async ({ ctx, input }) => {
          if (!notify.notices) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'notify.notices_unavailable' });
          try {
            return await notify.notices.publish(ctx.principal.userId, input);
          } catch (err) {
            typedRefusal(err);
          }
        },
        notifyRefusal,
      ),

      /**
       * Owner channel settings (I-order-01). Whether each out-of-app channel has
       * credentials (never the credentials), the owner's on/off switch and the
       * adapter name. A channel with no credentials stays `unconfigured`: a switch
       * cannot make it send.
       */
      channelSettings: mountRecord(
        NOTIFY_CHANNEL_SETTINGS,
        async () => (notify.channelSettings ? [...(await notify.channelSettings.get())] : typedUnavailable('channel_settings')),
        notifyRefusal,
      ),

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
      templates: mountRecord(
        NOTIFY_TEMPLATES,
        async () => (notify.templates ? [...(await notify.templates.list())] : typedUnavailable('templates')),
        notifyRefusal,
      ),

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
      alerts: mountRecord(
        NOTIFY_ALERTS,
        async ({ ctx, input }) => {
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
        },
        notifyRefusal,
      ),

      createAlert: mountRecord(
        NOTIFY_CREATE_ALERT,
        async ({ ctx, input }) => {
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
              source?: AlertPriceSource;
              channels?: AlertOutChannel[];
              webhookUrl?: string;
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
              ...(extras.source ? { source: extras.source } : {}),
              ...(extras.channels ? { channels: extras.channels } : {}),
              ...(extras.webhookUrl !== undefined ? { webhookUrl: extras.webhookUrl } : {}),
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
            if (err instanceof AlertValidationError) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: `${err.code}: ${err.message}`, cause: err });
            }
            if (err instanceof AlertWebhookError) {
              // A blank owner setting is a precondition; a URL the policy refuses is the caller's to fix.
              throw new TRPCError({
                code: err.code.startsWith('notify.') ? 'PRECONDITION_FAILED' : 'BAD_REQUEST',
                message: err.message,
                cause: err,
              });
            }
            throw err;
          }
        },
        notifyRefusal,
      ),

      /**
       * The owner's alert webhook policy as the alerts page publishes it (J-charts-desk-10 #4): the ports a webhook may use and the
       * resend schedule. Either blank is `null`, and the page says what that means: no webhook can be saved, or nothing is resent.
       */
      alertWebhookPolicy: mountRecord(
        NOTIFY_ALERT_WEBHOOK_POLICY,
        () => {
          const policy = alerts?.webhookPolicy() ?? NO_WEBHOOK_POLICY;
          return {
            ports: policy.ports ? [...policy.ports] : null,
            retrySeconds: policy.retrySeconds ? [...policy.retrySeconds] : null,
            timeoutMs: policy.timeoutMs,
          };
        },
        notifyRefusal,
      ),

      /**
       * A watchlist alert: the same price rule on each market named, one alert per market, all or none. Held to the price-alert
       * quota as a whole (a batch that would pass it creates nothing), and checked like a single create in every other way.
       */
      createAlerts: mountRecord(
        NOTIFY_CREATE_ALERTS,
        async ({ ctx, input }) => {
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
              ...(input.source ? { source: input.source } : {}),
            });
            return { alerts: rows.map(priceAlertToWire), evaluation: alerts.evaluationStatus() };
          } catch (err) {
            if (err instanceof AlertValidationError) throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
            throw alertManagerError(err);
          }
        },
        notifyRefusal,
      ),

      /**
       * A watchlist alert (J-charts-desk-09 #7): one price rule on every market of one of the person's watchlists, read from
       * identity. One price alert per market is stored with the rule, all or none, under the price-alert quota; each sweep then
       * adds an alert for a market added to the list since. Refuses `identity.watchlists_unavailable` when identity gives no
       * answer and `alert.watchlist_not_found` for a list the person does not have: never an empty list standing in for either.
       */
      createWatchlistAlert: mountRecord(
        NOTIFY_CREATE_WATCHLIST_ALERT,
        async ({ ctx, input }) => {
          if (!alerts || !watchRules) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'identity.watchlists_unavailable' });
          try {
            const made = await watchRules.create({ userId: ctx.principal.userId, ...input });
            return { rule: watchRuleToWire(made.rule), alerts: made.alerts.map(priceAlertToWire) };
          } catch (err) {
            if (err instanceof WatchRuleError) {
              throw new TRPCError({
                code: err.code === 'alert.watchlist_not_found' ? 'NOT_FOUND' : 'PRECONDITION_FAILED',
                message: err.code,
                cause: err,
              });
            }
            // Named by code (`alert.invalid_market: …`), so the page can say which refusal it was.
            throw alertManagerError(err);
          }
        },
        notifyRefusal,
      ),

      /** The person's watchlist alerts, newest first, each with the markets it covers and why its last sweep added nothing. */
      watchlistAlerts: mountRecord(
        NOTIFY_WATCHLIST_ALERTS,
        async ({ ctx }) => ({ items: watchRules ? (await watchRules.list(ctx.principal.userId)).map(watchRuleToWire) : [] }),
        notifyRefusal,
      ),

      /** Stop following a list. The alerts it made stay, each managed on its own. Stopping twice is harmless. */
      stopWatchlistAlert: mountRecord(
        NOTIFY_STOP_WATCHLIST_ALERT,
        async ({ ctx, input }) => {
          const row = watchRules ? await watchRules.stop(ctx.principal.userId, input.id) : null;
          return { rule: row ? watchRuleToWire(row) : null };
        },
        notifyRefusal,
      ),

      cancelAlert: mountRecord(
        NOTIFY_CANCEL_ALERT,
        async ({ ctx, input }) => {
          if (!alerts) return { cancelled: false, alert: null };
          const row = await alerts.cancel(ctx.principal.userId, input.id);
          if (!row) return { cancelled: false, alert: null };
          return { cancelled: row.status === 'cancelled', alert: priceAlertToWire(row) };
        },
        notifyRefusal,
      ),

      /**
       * Change an alert that is active or stopped. Only what is sent changes; `null` clears a name, message or expiry. Checked as a
       * create is: a blank owner setting refuses, a value outside a set one is a bad request. Nothing is written on a refusal.
       */
      updateAlert: mountRecord(
        NOTIFY_UPDATE_ALERT,
        async ({ ctx, input }) => {
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
              ...(input.source !== undefined ? { source: input.source } : {}),
            });
            if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'alert.not_found' });
            return { alert: priceAlertToWire(row) };
          } catch (err) {
            throw alertManagerError(err);
          }
        },
        notifyRefusal,
      ),

      /** Pause (`active: false`) an active alert or resume a stopped one. Repeating it is harmless: the alert is returned as it is. */
      setAlertActive: mountRecord(
        NOTIFY_SET_ALERT_ACTIVE,
        async ({ ctx, input }) => {
          if (!alerts) throw new TRPCError({ code: 'NOT_FOUND', message: 'alert.not_found' });
          try {
            const before = await alerts.get(ctx.principal.userId, input.id);
            const row = await alerts.setActive(ctx.principal.userId, input.id, input.active);
            if (!row || !before) throw new TRPCError({ code: 'NOT_FOUND', message: 'alert.not_found' });
            return { changed: row.status !== before.status, alert: priceAlertToWire(row) };
          } catch (err) {
            throw alertManagerError(err);
          }
        },
        notifyRefusal,
      ),

      /** How many price alerts the person holds open and the cap the owner set. `max: null` is a blank setting: creates refuse. */
      alertQuota: mountRecord(
        NOTIFY_ALERT_QUOTA,
        async ({ ctx }) => {
          if (!alerts) return { kind: 'price' as const, used: 0, max: null, burst: null, maxConditions: null };
          return alerts.quota(ctx.principal.userId);
        },
        notifyRefusal,
      ),

      /**
       * The person's trigger log: each time an alert fired and the mark that fired it, newest first. The owner sets how long
       * rows are kept; blank refuses `notify.alert_trigger_log_retention_unset` rather than answering an empty list.
       */
      alertTriggers: mountRecord(
        NOTIFY_ALERT_TRIGGERS,
        async ({ ctx, input }) => {
          if (!alerts) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: NOTIFY_ALERT_TRIGGER_LOG_RETENTION_UNSET });
          try {
            const log = await alerts.triggers(ctx.principal.userId, {
              ...(input.alertId ? { alertId: input.alertId } : {}),
              limit: input.limit,
            });
            const delivery = await alerts.triggerDeliveries(ctx.principal.userId, log.triggers);
            return {
              retentionDays: log.retentionDays,
              items: log.triggers.map((t) => {
                const d = delivery.get(`${t.alertId}:${t.seq}`);
                return {
                  alertId: t.alertId,
                  seq: t.seq,
                  marketId: t.marketId,
                  condition: t.condition,
                  targetPrice: t.targetPrice,
                  markPrice: t.markPrice,
                  firedAt: t.firedAt.toISOString(),
                  notificationId: t.notificationId,
                  deliveries: (d?.channels ?? []).map(deliveryToWire),
                  webhook: d?.webhook
                    ? {
                        status: d.webhook.status,
                        attempts: d.webhook.attempts.map((a) => ({ ...a })),
                        nextAttemptAt: d.webhook.nextAttemptAt ? d.webhook.nextAttemptAt.toISOString() : null,
                      }
                    : null,
                };
              }),
            };
          } catch (err) {
            throw alertManagerError(err);
          }
        },
        notifyRefusal,
      ),

      /** Delete an alert whatever its state. Deleting one that is already gone answers `deleted: false`. */
      deleteAlert: mountRecord(
        NOTIFY_DELETE_ALERT,
        async ({ ctx, input }) => {
          if (!alerts) return { deleted: false };
          return { deleted: await alerts.remove(ctx.principal.userId, input.id) };
        },
        notifyRefusal,
      ),

      /**
       * Condition eval against the sourced mark. Dark / missing MarkSource
       * refuses `alert.price_unavailable` and never returns fired as live.
       */
      evaluateAlert: mountRecord(
        NOTIFY_EVALUATE_ALERT,
        async ({ ctx, input }) => {
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
        },
        notifyRefusal,
      ),
    }),
  });
}

export type NotifyRouter = ReturnType<typeof createNotifyRouter>;
