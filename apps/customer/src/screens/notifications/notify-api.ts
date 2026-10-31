/**
 * The only file in this screen that talks to svc-notify (module `notify`, tRPC over the existing client). Names and shapes
 * are the real router's (`services/svc-notify/src/router.ts`): list({limit, cursor?, unreadOnly?}), unreadCount, markRead({ids}),
 * markAllRead, channels, mutePrefs, setMute. `limit` is always sent: the service refuses a list without one.
 */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';

const date = z.string().datetime({ offset: true });

export const notificationSchema = z.object({
  id: z.string().guid(),
  userId: z.string(),
  kind: z.string(),
  titleKey: z.string(),
  bodyKey: z.string(),
  title: z.string(),
  body: z.string(),
  params: z.record(z.string(), z.unknown()),
  href: z.string().nullable(),
  severity: z.enum(['info', 'action', 'critical']),
  readAt: date.nullable(),
  createdAt: date,
});
export type Notification = z.infer<typeof notificationSchema>;

const listSchema = z.object({ items: z.array(notificationSchema).max(100), nextCursor: z.string().guid().nullable() });
export type InboxPage = z.infer<typeof listSchema>;

const countSchema = z.object({ count: z.number().int().nonnegative() });
const markedSchema = z.object({ marked: z.number().int().nonnegative() });

export interface ListArgs {
  limit: number;
  cursor?: string | null;
  unreadOnly?: boolean;
}

export function listNotifications(api: ApiClient, args: ListArgs, signal?: AbortSignal): Promise<ApiResult<InboxPage>> {
  return api.query(
    'notify',
    'notify.list',
    { limit: args.limit, ...(args.cursor ? { cursor: args.cursor } : {}), ...(args.unreadOnly ? { unreadOnly: true } : {}) },
    listSchema,
    { signal },
  );
}

export async function unreadCount(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<number>> {
  const result = await api.query('notify', 'notify.unreadCount', undefined, countSchema, { signal });
  return result.ok ? { ok: true, data: result.data.count } : result;
}

export function markRead(api: ApiClient, ids: readonly string[]): Promise<ApiResult<{ marked: number }>> {
  return api.mutate('notify', 'notify.markRead', { ids }, markedSchema);
}

export function markAllRead(api: ApiClient): Promise<ApiResult<{ marked: number }>> {
  return api.mutate('notify', 'notify.markAllRead', {}, markedSchema);
}

const outOfApp = z.enum(['email', 'push', 'sms']);
export type OutOfAppChannel = z.infer<typeof outOfApp>;
const channelsSchema = z.array(
  z.object({ channel: z.enum(['inapp', 'email', 'push', 'sms']), configured: z.boolean(), available: z.boolean() }).passthrough(),
);
const prefsSchema = z.array(z.object({ channel: outOfApp, muted: z.boolean() })).max(3);
const targetsSchema = z.array(z.object({ channel: outOfApp, address: z.string(), verifiedAt: z.string().nullable() }).passthrough()).max(3);
export type ChannelRow = z.infer<typeof channelsSchema>[number];
export type MutePref = z.infer<typeof prefsSchema>[number];
export type TargetRow = z.infer<typeof targetsSchema>[number];

export const registerResultSchema = z
  .object({ status: z.enum(['sent', 'refused', 'failed']), channel: outOfApp, code: z.string().min(1).nullable(), expiresAt: z.string() })
  .refine((row) => (row.status === 'refused' ? row.code !== null : row.code === null), 'Invalid registration outcome');
export const verifyResultSchema = z
  .object({ verified: z.boolean(), code: z.string().min(1).nullable() })
  .refine((row) => !row.verified || row.code === null, 'Invalid verification outcome');
export type RegisterResult = z.infer<typeof registerResultSchema>;
export type VerifyResult = z.infer<typeof verifyResultSchema>;

/** Save an address for a channel and ask the service to send it a six-digit code. A new request replaces the earlier code. */
export function registerTarget(
  api: ApiClient,
  channel: OutOfAppChannel,
  address: string,
  locale: string,
): Promise<ApiResult<RegisterResult>> {
  return api.mutate(
    'notify',
    'notify.registerTarget',
    { channel, address, locale },
    registerResultSchema.refine((row) => row.channel === channel, 'Wrong registration channel'),
  );
}
export const verifyTarget = (api: ApiClient, channel: OutOfAppChannel, code: string): Promise<ApiResult<VerifyResult>> =>
  api.mutate('notify', 'notify.verifyTarget', { channel, code }, verifyResultSchema);
export const removeTarget = (api: ApiClient, channel: OutOfAppChannel): Promise<ApiResult<{ removed: boolean }>> =>
  api.mutate('notify', 'notify.removeTarget', { channel }, z.object({ removed: z.boolean() }));

const deliverySchema = z.object({
  channel: z.enum(['inapp', 'email', 'push', 'sms']),
  status: z.enum(['pending', 'accepted', 'refused', 'failed', 'abandoned']),
  attempts: z.number().int().nonnegative(),
  attemptedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  refusalCode: z.string().nullable(),
});
export type Delivery = z.infer<typeof deliverySchema>;
/** What happened to one of the signed-in person's notifications on each channel. An id that is not theirs returns an empty list. */
export const deliveries = (api: ApiClient, notificationId: string, signal?: AbortSignal): Promise<ApiResult<Delivery[]>> =>
  api.query('notify', 'notify.deliveries', { notificationId }, z.array(deliverySchema).max(8), { signal });

export const channelStatus = (api: ApiClient, signal?: AbortSignal) =>
  api.query('notify', 'notify.channels', undefined, channelsSchema, { signal });
export const mutePrefs = (api: ApiClient, signal?: AbortSignal) =>
  api.query('notify', 'notify.mutePrefs', undefined, prefsSchema, { signal });
const pushKeySchema = z.union([
  z.object({ publicKey: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/), unsetCode: z.null() }),
  z.object({ publicKey: z.null(), unsetCode: z.literal('notify.push_key_unset') }),
]);
export type PushKey = z.infer<typeof pushKeySchema>;
/** The push gateway's public application key a browser needs to subscribe; null while push delivery is not configured. */
export const pushKey = (api: ApiClient, signal?: AbortSignal) =>
  api.query('notify', 'notify.pushKey', undefined, pushKeySchema, { signal });
export const targets = (api: ApiClient, signal?: AbortSignal) =>
  api.query('notify', 'notify.targets', undefined, targetsSchema, { signal });
export function setMute(api: ApiClient, channel: OutOfAppChannel, muted: boolean): Promise<ApiResult<MutePref[]>> {
  return api.mutate(
    'notify',
    'notify.setMute',
    { channel, muted },
    prefsSchema.refine((rows) => rows.some((row) => row.channel === channel && row.muted === muted), 'Returned preference does not match'),
  );
}

export const CATEGORY_IDS = ['security', 'orders', 'price_alerts', 'promotions', 'news', 'status'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];
export const CATEGORY_CHANNELS = ['in_app', 'email', 'push', 'sms'] as const;
export type CategoryChannel = (typeof CATEGORY_CHANNELS)[number];
const categoryRowSchema = z.object({
  category: z.enum(CATEGORY_IDS),
  channel: z.enum(CATEGORY_CHANNELS),
  enabled: z.boolean(),
  /** The service keeps this cell on whatever is written (security and account-risk updates). */
  locked: z.boolean(),
  /** The platform can send on this channel at all. */
  configured: z.boolean(),
  /** Why the channel cannot send, when it was never connected (`vendor.email`, `vendor.push`, `vendor.sms`). */
  notConnected: z.enum(['vendor.email', 'vendor.push', 'vendor.sms']).nullable(),
});
export type CategoryPrefRow = z.infer<typeof categoryRowSchema>;
const categoryRowsSchema = z.array(categoryRowSchema).max(64);

/** `notify.categoryPrefs`: one row per category and channel for the signed-in person. */
export const categoryPrefs = (api: ApiClient, signal?: AbortSignal): Promise<ApiResult<CategoryPrefRow[]>> =>
  api.query('notify', 'notify.categoryPrefs', undefined, categoryRowsSchema, { signal });

/** `notify.setCategoryPref`: the service answers with every row, and `locked: true` when the cell cannot be changed. */
export function setCategoryPref(
  api: ApiClient,
  cell: { category: CategoryId; channel: CategoryChannel; enabled: boolean },
): Promise<ApiResult<{ rows: CategoryPrefRow[]; locked: boolean }>> {
  return api.mutate(
    'notify',
    'notify.setCategoryPref',
    { ...cell, clientRequestId: `catpref:${cell.category}:${cell.channel}:${cell.enabled}:${crypto.randomUUID()}` },
    z.object({ rows: categoryRowsSchema, locked: z.boolean() }),
  );
}

/** An out-of-app channel the service can really send through today. */
export function availableChannels(rows: readonly ChannelRow[]): OutOfAppChannel[] {
  return rows
    .filter((row): row is ChannelRow & { channel: OutOfAppChannel } => row.channel !== 'inapp' && row.configured && row.available)
    .map((row) => row.channel);
}

/** Tells the bell (and any open list) that something was read, so the count updates at once instead of at the next poll. */
const CHANGED = 'intafaced:notifications-changed';
export const announceChange = () => window.dispatchEvent(new Event(CHANGED));
export function onChange(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
}

// ── Price alerts ────────────────────────────────────────────────────────────────────────────────────────────────
// `notify.alerts` (scope notify:read) lists the person's watches with whether any can fire; `notify.createAlert` and
// `notify.cancelAlert` (scope notify:write) change them. Prices are decimal strings end to end, never a number. Neither
// mutation takes a request id, so a lost answer cannot be replayed safely; the page checks the list instead.

export const ALERT_KINDS = ['price', 'funding', 'liquidation_proximity', 'whale'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertDirection = 'above' | 'below';
export const ALERT_CONDITIONS = ['crossing', 'crossing_up', 'crossing_down', 'greater_than', 'less_than'] as const;
export type AlertCondition = (typeof ALERT_CONDITIONS)[number];

export const priceAlertSchema = z.object({
  id: z.string().guid(),
  userId: z.string(),
  marketId: z.string().min(1).max(64),
  kind: z.enum(ALERT_KINDS),
  direction: z.enum(['above', 'below']),
  targetPrice: z.string().min(1).max(64),
  status: z.enum(['active', 'fired', 'cancelled', 'expired', 'stopped']),
  firedAt: date.nullable(),
  createdAt: date,
  // Added by C-alerts-scan-01. A service that does not send them still parses: the page shows only what it was given.
  condition: z.enum(ALERT_CONDITIONS).optional(),
  name: z.string().max(200).nullable().optional(),
  message: z.string().max(2000).nullable().optional(),
  expiresAt: date.nullable().optional(),
  // Added by C-alerts-scan-01b: further level conditions that must hold together with the main one.
  extras: z.array(z.object({ condition: z.enum(['greater_than', 'less_than']), targetPrice: z.string().min(1).max(64) })).optional(),
  // Added by C-alerts-scan-01c: a repeating alert stays active and counts its triggers. A service that sends none means once.
  frequency: z.enum(['once', 'every_crossing']).optional(),
  fireCount: z.number().int().min(0).optional(),
  lastFiredAt: date.nullable().optional(),
  // When the alert last changed (an edit, a stop or a resume). A service that does not send it shows no modified time.
  updatedAt: date.optional(),
  // Why the platform stopped it: `burst` (it triggered too often). Null or absent for a pause by the person.
  stopReason: z.enum(['burst']).nullable().optional(),
});
export type PriceAlert = z.infer<typeof priceAlertSchema>;
export type AlertFrequency = 'once' | 'every_crossing';

export const alertEvaluationSchema = z.object({
  markSource: z.enum(['dark', 'live']),
  canFire: z.boolean(),
  code: z.enum(['alert.price_unavailable', 'alerts.whale_mark_dark', 'channel.not_configured', 'channel.disabled']).nullable(),
});
export type AlertEvaluation = z.infer<typeof alertEvaluationSchema>;

const alertListSchema = z.object({ items: z.array(priceAlertSchema).max(100), evaluation: alertEvaluationSchema });
export type AlertList = z.infer<typeof alertListSchema>;

/** The latest 100 watches, newest first. `limit` is always sent: the service refuses a list without one. */
export const listAlerts = (api: ApiClient, signal?: AbortSignal): Promise<ApiResult<AlertList>> =>
  api.query('notify', 'notify.alerts', { limit: 100 }, alertListSchema, { signal });

export interface AlertIntent {
  marketId: string;
  /** What the condition means as a side. A level (`greater_than`, `less_than`) is exactly this; `crossing` has none, and `above` is sent. */
  direction: AlertDirection;
  /** A positive decimal string, exactly as the person typed it (trimmed). */
  targetPrice: string;
  /** Left out, the service stores the level the direction names (what every alert meant before conditions existed). */
  condition?: AlertCondition;
  name?: string;
  message?: string;
  /** An ISO time. Left out, the alert is open-ended. */
  expiresAt?: string;
  /** Further level conditions on the same market; the alert triggers only when the main one and all of these hold. */
  extras?: AlertExtra[];
  /** Left out, the alert triggers once. `every_crossing` is for a crossing condition only. */
  frequency?: AlertFrequency;
}

export type AlertExtra = NonNullable<PriceAlert['extras']>[number];

/** The side a condition looks at. `crossing` looks at both, so it sends `above`, which the service ignores for it. */
export const directionOfCondition = (condition: AlertCondition): AlertDirection =>
  condition === 'less_than' || condition === 'crossing_down' ? 'below' : 'above';
/** True for the conditions that watch a crossing, the only ones that can repeat. */
export const isCrossing = (condition: AlertCondition): boolean =>
  condition === 'crossing' || condition === 'crossing_up' || condition === 'crossing_down';
const levelOfDirection = (direction: AlertDirection): AlertCondition => (direction === 'above' ? 'greater_than' : 'less_than');

/**
 * True when a stored watch is the one an intent asked for: same market, condition and price (100.50 equals 100.5), and the same
 * name, message and expiry when the intent has them. A service that sends no condition is read as the level the direction names.
 */
export function isIntent(
  row: Pick<PriceAlert, 'kind' | 'marketId' | 'direction' | 'targetPrice'> &
    Partial<Pick<PriceAlert, 'condition' | 'name' | 'message' | 'expiresAt' | 'extras' | 'frequency'>>,
  intent: AlertIntent,
): boolean {
  const wanted = intent.condition ?? levelOfDirection(intent.direction);
  const stored = row.condition ?? levelOfDirection(row.direction);
  return (
    row.kind === 'price' &&
    row.marketId === intent.marketId &&
    stored === wanted &&
    canonicalPrice(row.targetPrice) === canonicalPrice(intent.targetPrice) &&
    (row.frequency ?? 'once') === (intent.frequency ?? 'once') &&
    (intent.name === undefined || (row.name ?? '') === intent.name) &&
    (intent.message === undefined || (row.message ?? '') === intent.message) &&
    (intent.expiresAt === undefined || (row.expiresAt != null && Date.parse(row.expiresAt) === Date.parse(intent.expiresAt))) &&
    sameExtras(row.extras ?? [], intent.extras ?? [])
  );
}

/** Added conditions match one for one, in order. An alert with some is never the same alert as one without. */
function sameExtras(a: readonly AlertExtra[], b: readonly AlertExtra[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.condition === b[i]!.condition && canonicalPrice(x.targetPrice) === canonicalPrice(b[i]!.targetPrice))
  );
}

/** The same number spelled one way: no sign, no leading zeros, no trailing fraction zeros. Not a number: still a string. */
export function canonicalPrice(raw: string): string {
  const [whole = '', fraction = ''] = raw.trim().replace(/^\+/, '').split('.');
  const int = whole.replace(/^0+(?=\d)/, '') || '0';
  const frac = fraction.replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/** Save a price alert. The answer must be an active, unfired watch for exactly what was asked, or it is not believed. */
export function createPriceAlert(
  api: ApiClient,
  intent: AlertIntent,
  userId: string,
): Promise<ApiResult<{ alert: PriceAlert; evaluation: AlertEvaluation }>> {
  return api.mutate(
    'notify',
    'notify.createAlert',
    {
      kind: 'price',
      marketId: intent.marketId,
      direction: intent.direction,
      targetPrice: intent.targetPrice,
      ...(intent.condition ? { condition: intent.condition } : {}),
      ...(intent.name ? { name: intent.name } : {}),
      ...(intent.message ? { message: intent.message } : {}),
      ...(intent.expiresAt ? { expiresAt: intent.expiresAt } : {}),
      ...(intent.extras && intent.extras.length > 0 ? { extras: intent.extras } : {}),
      ...(intent.frequency && intent.frequency !== 'once' ? { frequency: intent.frequency } : {}),
    },
    z.object({
      alert: priceAlertSchema.refine(
        (row) => row.userId === userId && row.status === 'active' && row.firedAt === null && isIntent(row, intent),
        'Returned alert does not match',
      ),
      evaluation: alertEvaluationSchema,
    }),
  );
}

/** Cancel one watch. `cancelled: false` with a row means it was already fired or cancelled; `alert: null` means it was not found. */
export function cancelPriceAlert(
  api: ApiClient,
  id: string,
  userId: string,
): Promise<ApiResult<{ cancelled: boolean; alert: PriceAlert | null }>> {
  return api.mutate(
    'notify',
    'notify.cancelAlert',
    { id },
    z
      .object({
        cancelled: z.boolean(),
        alert: priceAlertSchema.refine((row) => row.id === id && row.userId === userId, 'Returned alert does not match').nullable(),
      })
      .refine((data) => data.cancelled === (data.alert?.status === 'cancelled'), 'Inconsistent cancel answer'),
  );
}

// ── Managing an alert (C-alerts-scan-02) ────────────────────────────────────────────────────────────────────────
// `notify.updateAlert`, `notify.setAlertActive` and `notify.deleteAlert` (scope notify:write); `notify.alertTriggers` (notify:read).
// Each change sets a value rather than adding to one, so repeating it after a lost answer does no harm.

/** What an edit may change. A name, message or stop time set to `null` is cleared; a field left out is not touched. */
export interface AlertEdit {
  targetPrice?: string;
  condition?: AlertCondition;
  name?: string | null;
  message?: string | null;
  expiresAt?: string | null;
}

/** Change an alert that is active or stopped. The answer must be this person's alert showing the values just sent, or it is not believed. */
export function updatePriceAlert(api: ApiClient, id: string, edit: AlertEdit, userId: string): Promise<ApiResult<{ alert: PriceAlert }>> {
  return api.mutate(
    'notify',
    'notify.updateAlert',
    { id, ...edit },
    z.object({
      alert: priceAlertSchema.refine(
        (row) =>
          row.id === id &&
          row.userId === userId &&
          (edit.targetPrice === undefined || canonicalPrice(row.targetPrice) === canonicalPrice(edit.targetPrice)) &&
          (edit.condition === undefined || row.condition === edit.condition) &&
          (edit.name === undefined || (row.name ?? null) === edit.name) &&
          (edit.message === undefined || (row.message ?? null) === edit.message),
        'Returned alert does not match',
      ),
    }),
  );
}

/** Pause (`active: false`) an active alert or resume a stopped one. The answer carries the status it ended in. */
export function setPriceAlertActive(
  api: ApiClient,
  id: string,
  active: boolean,
  userId: string,
): Promise<ApiResult<{ changed: boolean; alert: PriceAlert }>> {
  return api.mutate(
    'notify',
    'notify.setAlertActive',
    { id, active },
    z.object({
      changed: z.boolean(),
      alert: priceAlertSchema.refine((row) => row.id === id && row.userId === userId, 'Returned alert does not match'),
    }),
  );
}

/** Delete an alert whatever its state. `deleted: false` means it was already gone. */
export const deletePriceAlert = (api: ApiClient, id: string): Promise<ApiResult<{ deleted: boolean }>> =>
  api.mutate('notify', 'notify.deleteAlert', { id }, z.object({ deleted: z.boolean() }));

export const alertTriggerSchema = z.object({
  /** Which trigger of the alert this is, from 1; a repeating alert has one row for each. A service that sends none means 1. */
  seq: z.number().int().min(1).optional(),
  alertId: z.string().guid(),
  marketId: z.string().min(1).max(64),
  condition: z.enum(ALERT_CONDITIONS),
  targetPrice: z.string().min(1).max(64),
  markPrice: z.string().min(1).max(64),
  firedAt: date,
  notificationId: z.string().nullable(),
});
export type AlertTrigger = z.infer<typeof alertTriggerSchema>;
const alertTriggersSchema = z.object({ retentionDays: z.number().int().min(1), items: z.array(alertTriggerSchema).max(200) });
export type AlertTriggerPage = z.infer<typeof alertTriggersSchema>;

/** The person's triggers, newest first. `limit` is always sent. Refuses `notify.alert_trigger_log_retention_unset` while the platform has not set how long they are kept. */
export const listAlertTriggers = (
  api: ApiClient,
  args: { alertId?: string; limit: number },
  signal?: AbortSignal,
): Promise<ApiResult<AlertTriggerPage>> =>
  api.query(
    'notify',
    'notify.alertTriggers',
    { limit: args.limit, ...(args.alertId ? { alertId: args.alertId } : {}) },
    alertTriggersSchema,
    {
      signal,
    },
  );

// ── How many alerts a person may hold (C-alerts-scan-03a) ───────────────────────────────────────────────────────

const alertQuotaSchema = z.object({
  kind: z.literal('price'),
  used: z.number().int().min(0),
  max: z.number().int().min(1).nullable(),
  // The burst auto-stop rule, or null while the owner has not set it. A service that does not send it reads as unknown.
  burst: z
    .object({ windowMinutes: z.number().int().min(1), maxTriggers: z.number().int().min(1) })
    .nullable()
    .optional(),
});
export type AlertQuota = z.infer<typeof alertQuotaSchema>;

/** The price alerts the person holds open and the cap the platform set. `max: null` means the cap is not set, and a create is refused. */
export const readAlertQuota = (api: ApiClient, signal?: AbortSignal): Promise<ApiResult<AlertQuota>> =>
  api.query('notify', 'notify.alertQuota', undefined, alertQuotaSchema, { signal });

// ── A watchlist alert (C-alerts-scan-03c) ───────────────────────────────────────────────────────────────────────

export interface WatchlistIntent {
  marketIds: string[];
  direction: AlertDirection;
  condition: AlertCondition;
  /** A positive decimal string, exactly as the person typed it (trimmed). One price for every market. */
  targetPrice: string;
}

/**
 * Save one alert per market, all or none. The answer must be this person's active alerts, one for each market asked and no
 * others, each at the price asked, or it is not believed. No request id exists, so a lost answer is never retried here.
 */
export function createPriceAlerts(
  api: ApiClient,
  intent: WatchlistIntent,
  userId: string,
): Promise<ApiResult<{ alerts: PriceAlert[]; evaluation: AlertEvaluation }>> {
  const wanted = [...new Set(intent.marketIds)].sort();
  return api.mutate(
    'notify',
    'notify.createAlerts',
    {
      marketIds: intent.marketIds,
      direction: intent.direction,
      condition: intent.condition,
      targetPrice: intent.targetPrice,
    },
    z.object({
      alerts: z
        .array(priceAlertSchema)
        .min(1)
        .refine(
          (rows) =>
            rows.every(
              (row) =>
                row.userId === userId &&
                row.kind === 'price' &&
                row.status === 'active' &&
                row.firedAt === null &&
                canonicalPrice(row.targetPrice) === canonicalPrice(intent.targetPrice) &&
                (row.condition ?? levelOfDirection(row.direction)) === intent.condition,
            ) && JSON.stringify(rows.map((row) => row.marketId).sort()) === JSON.stringify(wanted),
          'Returned alerts do not match',
        ),
      evaluation: alertEvaluationSchema,
    }),
  );
}
