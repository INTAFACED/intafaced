import { z } from 'zod';
import { guestNotificationsRouter } from './guests/router.js';
import type { GuestNotificationService } from './guests/service.js';
import { router, publicProcedure, scopedProcedure, TRPCError } from '@intafaced/contracts';
import {
  NotifyListLimitUnsetError,
  NotifyOperatorDeliveriesLimitUnsetError,
  NotifyVerifyTtlUnsetError,
  assertNotifyListLimit,
  type NotifyService,
} from './notify-service.js';
import type { DeliveryRecord } from './channel-store.js';
import type { Notification } from './store.js';
import { CHANNEL_IDS, OUT_OF_APP_CHANNELS } from './channels/channel.js';
import { renderInboxCopy } from './channels/render.js';
import { assertNotifyAlertsListLimit, NotifyAlertsListLimitUnsetError, type AlertService } from './alerts/service.js';
import {
  AlertKindUnpublishedError,
  AlertPortfolioUnpublishedError,
  isSourcedAlertKind,
  isUnpublishedAlertKind,
  SOURCED_ALERT_KINDS,
  UNPUBLISHED_ALERT_KINDS,
  type PriceAlert,
} from './alerts/types.js';
import { describeChannelsPolicy } from './channels-policy.js';
import { describeAlertsPolicy } from './alerts-policy.js';
import { UNWIRED_VENUE_INCIDENT, resolveVenueIncident, venueIncidentOutput, type VenueIncidentLoader } from './venue-incident-truth.js';

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
  id: z.string().uuid(),
  userId: z.string(),
  kind: z.string(),
  titleKey: z.string(),
  bodyKey: z.string(),
  /** Catalog-resolved title. Unknown keys are the key string, never invented English. */
  title: z.string(),
  /** Catalog-resolved body. Unknown keys are the key string, never invented English. */
  body: z.string(),
  params: z.record(z.unknown()),
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
  id: z.string().uuid(),
  notificationId: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Page size. Optional here so omit reaches the named refuse
 * (`notify.operator_deliveries_limit_unset`) instead of a Zod "Required".
 * Blank is not 50; pass 50 explicitly when that is the page you want.
 */
const operatorDeliveriesInput = z.object({ limit: z.number().int().min(1).max(200).optional() }).optional();

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

function operatorDeliveryToWire(d: DeliveryRecord) {
  return {
    id: d.id,
    notificationId: d.notificationId,
    ...deliveryToWire(d),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

async function loadOperatorDeliveries(notify: NotifyService, limit: number | undefined) {
  try {
    return (await notify.operatorDeliveryOutcomes(limit)).map(operatorDeliveryToWire);
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

const priceAlertOutput = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  marketId: z.string(),
  kind: z.enum(SOURCED_ALERT_KINDS),
  direction: z.enum(['above', 'below']),
  targetPrice: z.string(),
  status: z.enum(['active', 'fired', 'cancelled']),
  firedAt: z.string().nullable(),
  createdAt: z.string(),
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
) {
  return router({
    guestNotifications: guestNotificationsRouter(guests),
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
              cursor: z.string().uuid().optional(),
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
            nextCursor: z.string().uuid().nullable(),
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
        .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }))
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
       * v22.alerts refuse honesty — price watch core, unpublished kinds, dark marks.
       *
       * Static board — integrators read this before wiring watch UI. Does not
       * reflect runtime mark wiring; use `alerts` / `evaluateAlert` for that.
       */
      alertsPolicy: publicProcedure.query(() => describeAlertsPolicy()),

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
            if (err instanceof NotifyVerifyTtlUnsetError) {
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
          const outcome = await notify.verifyTarget(ctx.principal.userId, input.channel, input.code);
          if (outcome.status === 'verified') return { verified: true, code: null };
          if (outcome.status === 'refused') return { verified: false, code: outcome.code };
          return { verified: false, code: null };
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
        .input(z.object({ notificationId: z.string().uuid() }))
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
        .query(async ({ input }) => loadOperatorDeliveries(notify, input?.limit)),

      ops: router({
        deliveries: scopedProcedure('admin:read', { module: 'notify' })
          .input(operatorDeliveriesInput)
          .output(z.array(operatorDeliveryOutput))
          .query(async ({ input }) => loadOperatorDeliveries(notify, input?.limit)),
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
              kind: z.enum(SOURCED_ALERT_KINDS).optional(),
              marketId: z.string().min(1).max(64),
              direction: z.enum(['above', 'below']),
              /** Decimal string — never a JSON number. */
              targetPrice: z.string().min(1).max(64),
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
          if (!('marketId' in input) || input.marketId === undefined || input.direction === undefined || input.targetPrice === undefined) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'alert.portfolio_view_unpublished: ledger portfolio view unpublished — notify holds no balance',
            });
          }
          const kind = input.kind ?? 'price';
          if (!isSourcedAlertKind(kind)) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: `alert.kind_unpublished: ${String(kind)} has no sourced series`,
            });
          }
          const row = await alerts.create({
            userId: ctx.principal.userId,
            marketId: input.marketId,
            kind,
            direction: input.direction,
            targetPrice: input.targetPrice,
          });
          return {
            alert: priceAlertToWire(row),
            evaluation: kind === 'whale' ? alerts.whaleEvaluationStatus() : alerts.evaluationStatus(),
          };
        }),

      cancelAlert: scopedProcedure('notify:write', { module: 'notify' })
        .input(z.object({ id: z.string().uuid() }))
        .output(z.object({ cancelled: z.boolean(), alert: priceAlertOutput.nullable() }))
        .mutation(async ({ ctx, input }) => {
          if (!alerts) return { cancelled: false, alert: null };
          const row = await alerts.cancel(ctx.principal.userId, input.id);
          if (!row) return { cancelled: false, alert: null };
          return { cancelled: row.status === 'cancelled', alert: priceAlertToWire(row) };
        }),

      /**
       * Condition eval against the sourced mark. Dark / missing MarkSource
       * refuses `alert.price_unavailable` and never returns fired as live.
       */
      evaluateAlert: scopedProcedure('notify:write', { module: 'notify' })
        .input(
          z.union([
            z.object({ id: z.string().uuid() }),
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
