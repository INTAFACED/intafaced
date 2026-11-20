/**
 * The only file in this screen that talks to svc-notify (module `notify`, tRPC over the existing client). Names and shapes
 * are the real router's (`services/svc-notify/src/router.ts`): list({limit, cursor?, unreadOnly?}), unreadCount, markRead({ids}),
 * markAllRead, channels, mutePrefs, setMute. `limit` is always sent: the service refuses a list without one.
 */
import { NOTIFY_INBOX_POLICY } from '@intafaced/contracts/notify-inbox-policy';
import {
  ALERT_CONDITIONS,
  ALERT_KINDS,
  ALERT_SOURCES,
  CATEGORY_CHANNELS,
  CATEGORY_IDS,
  WEBHOOK_CAUSES,
  alertEvaluationSchema,
  alertListSchema,
  alertQuotaSchema,
  alertTriggerSchema,
  alertTriggersSchema,
  cancelAlertReplySchema,
  categoryRowSchema,
  categoryRowsSchema,
  createAlertReplySchema,
  createAlertsReplySchema,
  createWatchRuleReplySchema,
  deleteAlertReplySchema,
  notificationSchema,
  notifyChannelsSchema,
  notifyCountSchema,
  notifyDeliverySchema,
  notifyListSchema,
  notifyMarkedSchema,
  notifyOutOfAppSchema,
  notifyPrefsSchema,
  notifyPushKeySchema,
  notifyRemovedSchema,
  notifyTargetsSchema,
  priceAlertSchema,
  registerResultSchema,
  setAlertActiveReplySchema,
  setCategoryPrefReplySchema,
  stopWatchRuleReplySchema,
  updateAlertReplySchema,
  verifyResultSchema,
  watchRuleSchema,
  watchRulesSchema,
  webhookAttemptSchema,
  webhookPolicySchema,
} from '@intafaced/contracts/notify-room';
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';

export {
  ALERT_CONDITIONS,
  ALERT_KINDS,
  ALERT_SOURCES,
  CATEGORY_CHANNELS,
  CATEGORY_IDS,
  WEBHOOK_CAUSES,
  alertEvaluationSchema,
  alertTriggerSchema,
  notificationSchema,
  priceAlertSchema,
  registerResultSchema,
  verifyResultSchema,
  watchRuleSchema,
};

export type Notification = z.infer<typeof notificationSchema>;

export type InboxPage = z.infer<typeof notifyListSchema>;

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
    notifyListSchema,
    { signal },
  );
}

export async function unreadCount(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<number>> {
  const result = await api.query('notify', 'notify.unreadCount', undefined, notifyCountSchema, { signal });
  return result.ok ? { ok: true, data: result.data.count } : result;
}

/** The owner's inbox settings: the page size `notify.list` is asked for and the bell's "<cap>+" ceiling; null while unset. */
export type InboxPolicy = { pageSize: number | null; unreadCap: number | null };
export async function inboxPolicy(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<InboxPolicy>> {
  const result = await api.call(NOTIFY_INBOX_POLICY, undefined, { signal });
  return result.ok ? { ok: true, data: { pageSize: result.data.pageSize, unreadCap: result.data.unreadCap } } : result;
}

export function markRead(api: ApiClient, ids: readonly string[]): Promise<ApiResult<{ marked: number }>> {
  return api.mutate('notify', 'notify.markRead', { ids }, notifyMarkedSchema);
}

export function markAllRead(api: ApiClient): Promise<ApiResult<{ marked: number }>> {
  return api.mutate('notify', 'notify.markAllRead', {}, notifyMarkedSchema);
}

export type OutOfAppChannel = z.infer<typeof notifyOutOfAppSchema>;
export type ChannelRow = z.infer<typeof notifyChannelsSchema>[number];
export type MutePref = z.infer<typeof notifyPrefsSchema>[number];
export type TargetRow = z.infer<typeof notifyTargetsSchema>[number];

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
  api.mutate('notify', 'notify.removeTarget', { channel }, notifyRemovedSchema);

export type Delivery = z.infer<typeof notifyDeliverySchema>;
/** What happened to one of the signed-in person's notifications on each channel. An id that is not theirs returns an empty list. */
export const deliveries = (api: ApiClient, notificationId: string, signal?: AbortSignal): Promise<ApiResult<Delivery[]>> =>
  api.query('notify', 'notify.deliveries', { notificationId }, z.array(notifyDeliverySchema).max(8), { signal });

export const channelStatus = (api: ApiClient, signal?: AbortSignal) =>
  api.query('notify', 'notify.channels', undefined, notifyChannelsSchema, { signal });
export const mutePrefs = (api: ApiClient, signal?: AbortSignal) =>
  api.query('notify', 'notify.mutePrefs', undefined, notifyPrefsSchema, { signal });
export type PushKey = z.infer<typeof notifyPushKeySchema>;
/** The push gateway's public application key a browser needs to subscribe; null while push delivery is not configured. */
export const pushKey = (api: ApiClient, signal?: AbortSignal) =>
  api.query('notify', 'notify.pushKey', undefined, notifyPushKeySchema, { signal });
export const targets = (api: ApiClient, signal?: AbortSignal) =>
  api.query('notify', 'notify.targets', undefined, notifyTargetsSchema, { signal });
export function setMute(api: ApiClient, channel: OutOfAppChannel, muted: boolean): Promise<ApiResult<MutePref[]>> {
  return api.mutate(
    'notify',
    'notify.setMute',
    { channel, muted },
    notifyPrefsSchema.refine(
      (rows) => rows.some((row) => row.channel === channel && row.muted === muted),
      'Returned preference does not match',
    ),
  );
}

export type CategoryId = (typeof CATEGORY_IDS)[number];
export type CategoryChannel = (typeof CATEGORY_CHANNELS)[number];
export type CategoryPrefRow = z.infer<typeof categoryRowSchema>;

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
    setCategoryPrefReplySchema,
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

export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertDirection = 'above' | 'below';
export type AlertCondition = (typeof ALERT_CONDITIONS)[number];

export type AlertSource = (typeof ALERT_SOURCES)[number];

export type PriceAlert = z.infer<typeof priceAlertSchema>;
export type AlertFrequency = 'once' | 'every_crossing';

export type AlertEvaluation = z.infer<typeof alertEvaluationSchema>;

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
  /** Left out, the alert watches the mark. */
  source?: AlertSource;
  /** The out-of-app channels for this alert; in-app is always written. Left out, the notification settings decide. */
  channels?: AlertChannel[];
  /** The person's own https endpoint, posted to each time the alert fires. */
  webhookUrl?: string;
}

/** Out-of-app channels an alert may use. */
export const ALERT_CHANNELS = ['email', 'push'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

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
    Partial<
      Pick<PriceAlert, 'condition' | 'name' | 'message' | 'expiresAt' | 'extras' | 'frequency' | 'source' | 'channels' | 'webhookUrl'>
    >,
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
    (row.source ?? 'mark') === (intent.source ?? 'mark') &&
    (intent.channels === undefined || sameChannels(row.channels ?? null, intent.channels)) &&
    (intent.webhookUrl === undefined || row.webhookUrl === normalisedUrl(intent.webhookUrl)) &&
    (intent.name === undefined || (row.name ?? '') === intent.name) &&
    (intent.message === undefined || (row.message ?? '') === intent.message) &&
    (intent.expiresAt === undefined || (row.expiresAt != null && Date.parse(row.expiresAt) === Date.parse(intent.expiresAt))) &&
    sameExtras(row.extras ?? [], intent.extras ?? [])
  );
}

function sameChannels(stored: readonly string[] | null, wanted: readonly string[]): boolean {
  return stored !== null && stored.length === wanted.length && wanted.every((c) => stored.includes(c));
}

/** A URL as the service stores it (`https://Host/` becomes `https://host/`); a string that is not one is compared as typed. */
function normalisedUrl(raw: string): string {
  try {
    return new URL(raw.trim()).toString();
  } catch {
    return raw.trim();
  }
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
      ...(intent.source && intent.source !== 'mark' ? { source: intent.source } : {}),
      ...(intent.channels ? { channels: intent.channels } : {}),
      ...(intent.webhookUrl ? { webhookUrl: intent.webhookUrl } : {}),
    },
    createAlertReplySchema.extend({
      alert: createAlertReplySchema.shape.alert.refine(
        (row) => row.userId === userId && row.status === 'active' && row.firedAt === null && isIntent(row, intent),
        'Returned alert does not match',
      ),
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
    cancelAlertReplySchema
      .extend({
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
  /** The price a price alert watches. Left out, the stored one is kept. */
  source?: AlertSource;
}

/** Change an alert that is active or stopped. The answer must be this person's alert showing the values just sent, or it is not believed. */
export function updatePriceAlert(api: ApiClient, id: string, edit: AlertEdit, userId: string): Promise<ApiResult<{ alert: PriceAlert }>> {
  return api.mutate(
    'notify',
    'notify.updateAlert',
    { id, ...edit },
    updateAlertReplySchema.extend({
      alert: updateAlertReplySchema.shape.alert.refine(
        (row) =>
          row.id === id &&
          row.userId === userId &&
          (edit.targetPrice === undefined || canonicalPrice(row.targetPrice) === canonicalPrice(edit.targetPrice)) &&
          (edit.condition === undefined || row.condition === edit.condition) &&
          (edit.name === undefined || (row.name ?? null) === edit.name) &&
          (edit.message === undefined || (row.message ?? null) === edit.message) &&
          (edit.source === undefined || (row.source ?? 'mark') === edit.source),
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
    setAlertActiveReplySchema.extend({
      alert: setAlertActiveReplySchema.shape.alert.refine((row) => row.id === id && row.userId === userId, 'Returned alert does not match'),
    }),
  );
}

/** Delete an alert whatever its state. `deleted: false` means it was already gone. */
export const deletePriceAlert = (api: ApiClient, id: string): Promise<ApiResult<{ deleted: boolean }>> =>
  api.mutate('notify', 'notify.deleteAlert', { id }, deleteAlertReplySchema);

export type WebhookCause = (typeof WEBHOOK_CAUSES)[number];
export type WebhookAttempt = z.infer<typeof webhookAttemptSchema>;

export type AlertTrigger = z.infer<typeof alertTriggerSchema>;

export type WebhookPolicy = z.infer<typeof webhookPolicySchema>;
export const readWebhookPolicy = (api: ApiClient, signal?: AbortSignal): Promise<ApiResult<WebhookPolicy>> =>
  api.query('notify', 'notify.alertWebhookPolicy', undefined, webhookPolicySchema, { signal });
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
    createAlertsReplySchema.extend({
      alerts: createAlertsReplySchema.shape.alerts.refine(
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
    }),
  );
}

// ── Following a watchlist (J-charts-desk-09 #7, C-alerts-scan-03) ───────────────────────────────────────────────
// `notify.createWatchlistAlert` and `notify.stopWatchlistAlert` (notify:write), `notify.watchlistAlerts` (notify:read). The list is
// the account's own (`trade.watchlists`), read by the service from identity: the page sends only which list, never its markets.

/** Why the last check of a followed list added nothing it should have. Null when it had nothing to refuse. */
export const WATCH_RULE_SYNC_CODES = [
  'identity.watchlists_unavailable',
  'alert.watchlist_not_found',
  'alert.markets_unavailable',
  'alert.quota_reached',
  'notify.alert_quota_unset',
  'alert.watchlist_sync_failed',
] as const;
export type WatchRuleSyncCode = (typeof WATCH_RULE_SYNC_CODES)[number];

export type WatchRule = z.infer<typeof watchRuleSchema>;

export const listWatchRules = (api: ApiClient, signal?: AbortSignal): Promise<ApiResult<{ items: WatchRule[] }>> =>
  api.query('notify', 'notify.watchlistAlerts', undefined, watchRulesSchema, { signal });

export interface FollowIntent {
  listId: string;
  condition: AlertCondition;
  /** A positive decimal string, exactly as the person typed it (trimmed). */
  targetPrice: string;
}

/** Follow a list. The answer must be this person's alerts, one per covered market, each with the rule just sent, or it is not believed. */
export function createWatchRule(
  api: ApiClient,
  intent: FollowIntent,
  userId: string,
): Promise<ApiResult<{ rule: WatchRule; alerts: PriceAlert[] }>> {
  return api.mutate(
    'notify',
    'notify.createWatchlistAlert',
    { listId: intent.listId, condition: intent.condition, targetPrice: intent.targetPrice },
    createWatchRuleReplySchema.refine(
      ({ rule, alerts }) =>
        rule.listId === intent.listId &&
        rule.condition === intent.condition &&
        canonicalPrice(rule.targetPrice) === canonicalPrice(intent.targetPrice) &&
        alerts.every(
          (row) =>
            row.userId === userId &&
            row.kind === 'price' &&
            row.status === 'active' &&
            row.condition === intent.condition &&
            canonicalPrice(row.targetPrice) === canonicalPrice(intent.targetPrice),
        ) &&
        JSON.stringify(alerts.map((row) => row.marketId).sort()) === JSON.stringify([...rule.markets].sort()),
      'Returned alerts do not match',
    ),
  );
}

/** Stop following a list. Its alerts stay. Stopping twice is harmless. */
export const stopWatchRule = (api: ApiClient, id: string): Promise<ApiResult<{ rule: WatchRule | null }>> =>
  api.mutate(
    'notify',
    'notify.stopWatchlistAlert',
    { id },
    stopWatchRuleReplySchema.refine(
      ({ rule }) => rule === null || (rule.id === id && rule.status === 'stopped'),
      'Returned rule does not match',
    ),
  );
