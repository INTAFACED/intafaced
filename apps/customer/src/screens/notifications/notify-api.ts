/**
 * The only file in this screen that talks to svc-notify (module `notify`, tRPC over the existing client). Names and shapes
 * are the real router's (`services/svc-notify/src/router.ts`): list({limit, cursor?, unreadOnly?}), unreadCount, markRead({ids}),
 * markAllRead, channels, mutePrefs, setMute. `limit` is always sent: the service refuses a list without one.
 */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';

const date = z.string().datetime({ offset: true });

export const notificationSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  kind: z.string(),
  titleKey: z.string(),
  bodyKey: z.string(),
  title: z.string(),
  body: z.string(),
  params: z.record(z.unknown()),
  href: z.string().nullable(),
  severity: z.enum(['info', 'action', 'critical']),
  readAt: date.nullable(),
  createdAt: date,
});
export type Notification = z.infer<typeof notificationSchema>;

const listSchema = z.object({ items: z.array(notificationSchema).max(100), nextCursor: z.string().uuid().nullable() });
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
  channel: 'email' | 'sms',
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
  id: z.string().uuid(),
  userId: z.string(),
  marketId: z.string().min(1).max(64),
  kind: z.enum(ALERT_KINDS),
  direction: z.enum(['above', 'below']),
  targetPrice: z.string().min(1).max(64),
  status: z.enum(['active', 'fired', 'cancelled', 'expired']),
  firedAt: date.nullable(),
  createdAt: date,
  // Added by C-alerts-scan-01. A service that does not send them still parses: the page shows only what it was given.
  condition: z.enum(ALERT_CONDITIONS).optional(),
  name: z.string().max(200).nullable().optional(),
  message: z.string().max(2000).nullable().optional(),
  expiresAt: date.nullable().optional(),
});
export type PriceAlert = z.infer<typeof priceAlertSchema>;

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
  direction: AlertDirection;
  /** A positive decimal string, exactly as the person typed it (trimmed). */
  targetPrice: string;
}

/** True when a stored watch is the one an intent asked for: same market, side and price (100.50 equals 100.5). */
export function isIntent(row: Pick<PriceAlert, 'kind' | 'marketId' | 'direction' | 'targetPrice'>, intent: AlertIntent): boolean {
  return (
    row.kind === 'price' &&
    row.marketId === intent.marketId &&
    row.direction === intent.direction &&
    canonicalPrice(row.targetPrice) === canonicalPrice(intent.targetPrice)
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
    { kind: 'price', marketId: intent.marketId, direction: intent.direction, targetPrice: intent.targetPrice },
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
