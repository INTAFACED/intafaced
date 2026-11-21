import { z } from 'zod';
import { noticeCategorySchema } from './status-page.js';
import { jsonValueSchema } from './procedure-strict-schema.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-notify's records share, moved from the service so the records and every caller read one copy. */

/** Every way of reaching a user. `inapp` is always available; the rest are adapters. */
export const CHANNEL_IDS = ['inapp', 'email', 'push', 'sms'] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];

/** Channels that leave the platform and therefore need an address and credentials. */
export const OUT_OF_APP_CHANNELS = ['email', 'push', 'sms'] as const satisfies readonly ChannelId[];

export const outOfAppChannelSchema = z.enum(OUT_OF_APP_CHANNELS);

export const channelSettingOutput = z.object({
  channel: outOfAppChannelSchema,
  configured: z.boolean(),
  requires: z.array(z.string()),
  enabled: z.boolean().nullable(),
  adapter: z.string().nullable(),
  version: z.number().int().nonnegative(),
  effective: z.enum(['sending', 'disabled', 'unconfigured']),
  notConnected: z.string().nullable(),
});

export const TEMPLATE_KEYS = [
  'recovery_code',
  'verification_code',
  'login_code',
  'registration_code',
  'security_notice',
  'kyc_decision',
] as const;

export const templateKeySchema = z.enum(TEMPLATE_KEYS);

export const templateOutput = z.object({
  key: templateKeySchema,
  fields: z.array(z.string()),
  current: z
    .object({ version: z.number().int().positive(), subject: z.string(), body: z.string(), authorId: z.string(), createdAt: z.string() })
    .nullable(),
});

/**
 * `fee_change` announces a new trading fee schedule version: `startsAt` is the time it takes effect, and it has no end.
 * It is read before that time and changes no rate itself; the rate changes only with svc-trade's stored version.
 */
export const NOTICE_KINDS = ['announcement', 'maintenance', 'incident', 'changelog', 'fee_change'] as const;

/**
 * Funding incident status flow. A scoped incident (one asset on one network)
 * names its phase on every entry; only the closing entry reads `resolved`.
 */
export const INCIDENT_PHASES = ['investigating', 'identified', 'update', 'monitoring', 'resolved'] as const;

/**
 * Developer changelog entries. A changelog notice can carry the product area it
 * belongs to, whether it breaks callers, the endpoints and scopes it adds, the
 * dates it was added and takes effect, a before-and-after example, a migration
 * note and the endpoints it retires. A release date is never filled in for the
 * author: an entry with none reads `releaseOn: null` and is not listed as
 * upcoming.
 */
export const CHANGELOG_AREAS = [
  'trading',
  'market_data',
  'account',
  'wallet',
  'payments',
  'webhooks',
  'websocket',
  'fix',
  'authentication',
] as const;

export const changelogArea = z.enum(CHANGELOG_AREAS);

export const changelogDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const changelogOutput = z.object({
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

export const NOTICE_AUDIENCES = ['everyone', 'p2p-merchants'] as const;

export const noticeWireOutput = z.object({
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

export const statusImpact = z.enum(['none', 'minor', 'major', 'critical']);

export const STATUS_COMPONENT_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

/** Asset symbol and network slug as the asset registry spells them. */
export const NOTICE_ASSET_PATTERN = /^[A-Z0-9]{2,20}$/;

export const noticeAsset = z.string().regex(NOTICE_ASSET_PATTERN);

export const NOTICE_NETWORK_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

export const noticeNetwork = z.string().regex(NOTICE_NETWORK_PATTERN);

/** What an author sends for a changelog entry. Area, dates and the rest are validated again on the board. */
export const changelogInput = z.object({
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

export const MAINTENANCE_REMINDER_MINUTES_MAX = 43_200;

/** At most this many reminders on one window, each 1 minute to 30 days before its start: storage bounds, not owner values. */
export const MAINTENANCE_REMINDERS_MAX = 10;

export const proposalOutput = z.object({ targetId: z.string(), expectedVersion: z.string(), payloadHash: z.string() });

/**
 * Recipient health: which addresses keep failing, and the quarantine that follows.
 *
 * A TERMINAL failure is the unit: a send that ended `abandoned` (the gateway
 * rejected it for good, or the attempt budget was spent). A `failed` attempt that
 * will be retried is not counted, so a short provider outage retried on the bus
 * does not quarantine anybody. Consecutive terminal failures to one address,
 * reaching the OWNER-SET threshold, quarantine it. A blank threshold quarantines
 * nobody: the page says so and the dispatcher never consults the table.
 *
 * What quarantine does: a non-critical send to the address is refused
 * `channel.recipient_quarantined` with the stored reason, and a release (reason
 * required, audited, keyed by a request id) lets sends resume. Critical messages
 * are still attempted: the one state where a margin call is not tried must not be
 * a bookkeeping state. If a provider outage abandons many sends at once, many
 * recipients can be quarantined; the release action and the threshold are the
 * owner's lever for that.
 *
 * No money moves. This holds no balance.
 */
export type RecipientState = 'active' | 'unconfirmed' | 'quarantined';

export const RECIPIENT_STATES: readonly RecipientState[] = ['active', 'unconfirmed', 'quarantined'];

/**
 * Page size. Optional here so omit reaches the named refuse
 * (`notify.operator_deliveries_limit_unset`) instead of a Zod "Required".
 * Blank is not 50; pass 50 explicitly when that is the page you want.
 */
export const operatorDeliveriesInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    status: z.enum(['pending', 'accepted', 'refused', 'failed', 'abandoned']).optional(),
  })
  .optional();

export const channelSchema = z.enum(CHANNEL_IDS);

export const deliveryOutput = z.object({
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
export const operatorDeliveryOutput = deliveryOutput.extend({
  id: z.string().guid(),
  notificationId: z.string().guid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Watches evaluated against an injected mark source. */
export type SourcedAlertKind = 'price' | 'funding' | 'liquidation_proximity' | 'whale';

export const SOURCED_ALERT_KINDS = ['price', 'funding', 'liquidation_proximity', 'whale'] as const satisfies readonly SourcedAlertKind[];

/**
 * How a watch compares the mark with its target.
 *
 *   greater_than / less_than   a LEVEL: fires whenever the mark is at or above (below) the target. The only conditions that
 *                              existed before C-alerts-scan-01, stored as direction above / below.
 *   crossing_up / crossing_down / crossing   fire only on a CHANGE of side, seen between two sweeps. The side the mark was last
 *                              seen on is `lastSide`; a watch with no observation yet fires nothing and records one.
 */
export type AlertCondition = 'crossing' | 'crossing_up' | 'crossing_down' | 'greater_than' | 'less_than';

export const ALERT_CONDITIONS = [
  'crossing',
  'crossing_up',
  'crossing_down',
  'greater_than',
  'less_than',
] as const satisfies readonly AlertCondition[];

/** An added condition: a level only (crossing needs a remembered side, which an added condition does not have). */
export const EXTRA_CONDITIONS = ['greater_than', 'less_than'] as const;

/**
 * How often an alert may trigger. `once` is the original rule: the alert triggers and is done. `every_crossing` keeps a crossing
 * alert active, so it triggers each time the mark crosses the level again. Which of the repeating ones a deployment allows is an
 * owner setting (`NOTIFY_ALERT_FREQUENCIES`); `once` is always allowed.
 */
export type AlertFrequency = 'once' | 'every_crossing';

export const ALERT_FREQUENCIES = ['once', 'every_crossing'] as const satisfies readonly AlertFrequency[];

/**
 * Which price a price alert is evaluated against. `mark` is the original rule: mid of bid and ask when the book is two-sided,
 * else last. `bid`, `ask` and `last` read that one field of the ticker; a ticker without it refuses
 * `notify.price_source_unavailable` and never falls back to another side. Only kind `price` uses it.
 */
export type AlertPriceSource = 'mark' | 'bid' | 'ask' | 'last';

export const ALERT_PRICE_SOURCES = ['mark', 'bid', 'ask', 'last'] as const satisfies readonly AlertPriceSource[];

/** Out-of-app channels an alert may ask for. SMS is not offered for alerts. */
export const ALERT_OUT_CHANNELS = ['email', 'push'] as const;

export const priceAlertOutput = z.object({
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
  /** Which price the alert is evaluated against. `mark` for every alert made before the person could choose. */
  source: z.enum(ALERT_PRICE_SOURCES),
  /** Times a repeating alert has triggered; zero for a one-shot alert. */
  fireCount: z.number().int(),
  /** Why a stopped alert was stopped by the platform: `burst` (it triggered too often). Null for a pause by the person. */
  stopReason: z.enum(['burst']).nullable(),
  lastFiredAt: z.string().nullable(),
  /** The out-of-app channels chosen for this alert; null follows the person's notification settings. */
  channels: z.array(z.enum(ALERT_OUT_CHANNELS)).nullable(),
  webhookUrl: z.string().nullable(),
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
export const alertEvaluationOutput = z.object({
  markSource: z.enum(['dark', 'live']),
  canFire: z.boolean(),
  code: z.enum(['alert.price_unavailable', 'alerts.whale_mark_dark', 'channel.not_configured', 'channel.disabled']).nullable(),
});

/**
 * What an alert may carry beyond market, side and price (C-alerts-scan-01). The lengths here are only an input bound; the owner's
 * limits are checked by the service, which refuses when they are blank.
 */
export const alertExtras = {
  /** How the mark is compared with the target. Omitted: a level in the direction given. */
  condition: z.enum(ALERT_CONDITIONS).optional(),
  name: z.string().max(2000).optional(),
  message: z.string().max(2000).optional(),
  /** ISO time. Omitted: open-ended. */
  expiresAt: z.string().datetime({ offset: true }).optional(),
  /** `once` (the default) or a repeating frequency the owner allows; a repeating alert must be a crossing. */
  frequency: z.enum(ALERT_FREQUENCIES).optional(),
  /** Which price a price alert is evaluated against: `mark` (the default: mid when two-sided, else last), `bid`, `ask` or `last`. */
  source: z.enum(ALERT_PRICE_SOURCES).optional(),
  /** Added level conditions on the same market; all must hold with the main one. */
  extras: z
    .array(z.object({ condition: z.enum(EXTRA_CONDITIONS), targetPrice: z.string().min(1).max(64) }))
    .max(20)
    .optional(),
  /** Out-of-app channels for this alert; in-app is always written. Omitted: the person's notification settings decide. */
  channels: z.array(z.enum(ALERT_OUT_CHANNELS)).max(ALERT_OUT_CHANNELS.length).optional(),
  /** The person's own https endpoint, posted to each time the alert fires. Checked by the service (alerts/webhook.ts). */
  webhookUrl: z.string().max(2048).optional(),
};

/**
 * Kinds with no sourced series. Create never stores; evaluate never fires.
 * Intelligence stays here. Whale does not — it evaluates against the whale
 * mark or refuses `alerts.whale_mark_dark`.
 */
export type UnpublishedAlertKind = 'intelligence';

export const UNPUBLISHED_ALERT_KINDS = ['intelligence'] as const satisfies readonly UnpublishedAlertKind[];

export const categoryPrefRowOutput = z.object({
  category: z.enum(['security', 'orders', 'price_alerts', 'promotions', 'news', 'status']),
  channel: z.enum(['email', 'push', 'sms', 'in_app']),
  enabled: z.boolean(),
  locked: z.boolean(),
  configured: z.boolean(),
  notConnected: z.enum(['vendor.email', 'vendor.push', 'vendor.sms']).nullable(),
});

export const categoryPrefResultOutput = z.object({
  rows: z.array(categoryPrefRowOutput),
  locked: z.boolean(),
});

/** One webhook attempt as the page shows it: a status and a cause code, never the endpoint's answer body. */
export const webhookAttemptOutput = z.object({
  n: z.number().int(),
  at: z.string(),
  status: z.number().int().nullable(),
  cause: z.enum(['ok', 'redirect', 'refused', 'unavailable', 'gateway_timeout', 'timeout', 'unreachable', 'private_address']),
  durationMs: z.number().int(),
});

export const watchRuleOutput = z.object({
  id: z.string(),
  listId: z.string(),
  listName: z.string(),
  condition: z.enum(ALERT_CONDITIONS),
  targetPrice: z.string(),
  status: z.enum(['active', 'stopped']),
  markets: z.array(z.string()),
  createdAt: z.string(),
  lastSyncAt: z.string().nullable(),
  lastSyncCode: z.string().nullable(),
});

export const statusComponentId = z.enum(['api', 'webhooks', 'console']);

export const statusFeedOutput = z.object({
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

/** A language code as the app names one (`es`, `pt-BR`); one the app does not offer reads the source text. */
export const noticeLanguage = z.string().min(2).max(8);

/** A notice read in one language: its text in that language or the source text, and which language it is in. */
export const localizedNoticeOutput = noticeWireOutput.extend({ language: z.string() });

/** The longest window a founder may read at once, in days. */
export const NAV_METRIC_DAYS_MAX = 90;

export const VENUE_INCIDENT_CODES = [
  'notify.venue_halted',
  'notify.market_halted',
  'notify.venue_halt_unavailable',
  'notify.incident_silence',
  'notify.incident_all_clear_refused',
] as const;

export const venueIncidentOutput = z.object({
  allFine: z.boolean(),
  matching: z.enum(['unwired', 'open', 'halted', 'unavailable']),
  code: z.enum(VENUE_INCIDENT_CODES).nullable(),
  incidentSilence: z.boolean(),
  allClear: z.boolean(),
});

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
export const severitySchema = z.enum(['info', 'action', 'critical']);

export const notificationOutput = z.object({
  id: z.string().guid(),
  userId: z.string(),
  kind: z.string(),
  titleKey: z.string(),
  bodyKey: z.string(),
  /** Catalog-resolved title. Unknown keys are the key string, never invented English. */
  title: z.string(),
  /** Catalog-resolved body. Unknown keys are the key string, never invented English. */
  body: z.string(),
  params: z.record(z.string(), jsonValueSchema),
  href: z.string().nullable(),
  severity: severitySchema,
  readAt: z.string().nullable(),
  sourceSubject: z.string(),
  sourceIdempotencyKey: z.string(),
  createdAt: z.string(),
});
