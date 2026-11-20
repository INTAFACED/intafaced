/**
 * What svc-notify answers the customer's notifications room (module `notify`): the inbox, channels and targets, category
 * preferences, price alerts and their triggers, and followed watchlists. Browser-safe (zod only), so the app reads each
 * answer with the one schema here and narrows it where a caller needs more.
 */
import { z } from 'zod';

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

export const notifyListSchema = z.object({ items: z.array(notificationSchema).max(100), nextCursor: z.string().guid().nullable() });

export const notifyCountSchema = z.object({ count: z.number().int().nonnegative() });
export const notifyMarkedSchema = z.object({ marked: z.number().int().nonnegative() });

export const notifyOutOfAppSchema = z.enum(['email', 'push', 'sms']);
export const notifyChannelsSchema = z.array(
  z.object({ channel: z.enum(['inapp', 'email', 'push', 'sms']), configured: z.boolean(), available: z.boolean() }).passthrough(),
);
export const notifyPrefsSchema = z.array(z.object({ channel: notifyOutOfAppSchema, muted: z.boolean() })).max(3);
export const notifyTargetsSchema = z
  .array(z.object({ channel: notifyOutOfAppSchema, address: z.string(), verifiedAt: z.string().nullable() }).passthrough())
  .max(3);

export const registerResultSchema = z
  .object({
    status: z.enum(['sent', 'refused', 'failed']),
    channel: notifyOutOfAppSchema,
    code: z.string().min(1).nullable(),
    expiresAt: z.string(),
  })
  .refine((row) => (row.status === 'refused' ? row.code !== null : row.code === null), 'Invalid registration outcome');
export const verifyResultSchema = z
  .object({ verified: z.boolean(), code: z.string().min(1).nullable() })
  .refine((row) => !row.verified || row.code === null, 'Invalid verification outcome');
export const notifyRemovedSchema = z.object({ removed: z.boolean() });

export const notifyDeliverySchema = z.object({
  channel: z.enum(['inapp', 'email', 'push', 'sms']),
  status: z.enum(['pending', 'accepted', 'refused', 'failed', 'abandoned']),
  attempts: z.number().int().nonnegative(),
  attemptedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  refusalCode: z.string().nullable(),
});

export const notifyPushKeySchema = z.union([
  z.object({ publicKey: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/), unsetCode: z.null() }),
  z.object({ publicKey: z.null(), unsetCode: z.literal('notify.push_key_unset') }),
]);

export const CATEGORY_IDS = ['security', 'orders', 'price_alerts', 'promotions', 'news', 'status'] as const;
export const CATEGORY_CHANNELS = ['in_app', 'email', 'push', 'sms'] as const;
export const categoryRowSchema = z.object({
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
export const categoryRowsSchema = z.array(categoryRowSchema).max(64);
/** `notify.setCategoryPref`: the service answers with every row, and `locked: true` when the cell cannot be changed. */
export const setCategoryPrefReplySchema = z.object({ rows: categoryRowsSchema, locked: z.boolean() });

export const ALERT_KINDS = ['price', 'funding', 'liquidation_proximity', 'whale'] as const;
export const ALERT_CONDITIONS = ['crossing', 'crossing_up', 'crossing_down', 'greater_than', 'less_than'] as const;
/** The price an alert watches: the mark (mid of the book, the last trade when one side is empty), the bid, the ask or the last trade. */
export const ALERT_SOURCES = ['mark', 'bid', 'ask', 'last'] as const;

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
  // A service that does not send these still parses: the page shows only what it was given.
  condition: z.enum(ALERT_CONDITIONS).optional(),
  name: z.string().max(200).nullable().optional(),
  message: z.string().max(2000).nullable().optional(),
  expiresAt: date.nullable().optional(),
  // Further level conditions that must hold together with the main one.
  extras: z.array(z.object({ condition: z.enum(['greater_than', 'less_than']), targetPrice: z.string().min(1).max(64) })).optional(),
  // A repeating alert stays active and counts its triggers. A service that sends none means once.
  frequency: z.enum(['once', 'every_crossing']).optional(),
  fireCount: z.number().int().min(0).optional(),
  lastFiredAt: date.nullable().optional(),
  // When the alert last changed (an edit, a stop, a resume, or how it ended). A service that does not send it shows no
  // modified time.
  updatedAt: date.optional(),
  // Why the platform stopped it: `burst` (it triggered too often). Null or absent for a pause by the person.
  stopReason: z.enum(['burst']).nullable().optional(),
  // The price it watches. A service that does not send it watches the mark.
  source: z.enum(ALERT_SOURCES).optional(),
  // The out-of-app channels chosen for this alert (null: the notification settings decide) and the person's own webhook.
  // A service that does not send them shows neither.
  channels: z
    .array(z.enum(['email', 'push']))
    .nullable()
    .optional(),
  webhookUrl: z.string().max(2048).nullable().optional(),
});

export const alertEvaluationSchema = z.object({
  markSource: z.enum(['dark', 'live']),
  canFire: z.boolean(),
  code: z.enum(['alert.price_unavailable', 'alerts.whale_mark_dark', 'channel.not_configured', 'channel.disabled']).nullable(),
});

export const alertListSchema = z.object({ items: z.array(priceAlertSchema).max(100), evaluation: alertEvaluationSchema });

/** `notify.createAlert`'s answer: the saved watch and whether any watch can fire. */
export const createAlertReplySchema = z.object({ alert: priceAlertSchema, evaluation: alertEvaluationSchema });
/** `notify.cancelAlert`'s answer. `cancelled: false` with a row means it was already fired or cancelled; `alert: null` means it was not found. */
export const cancelAlertReplySchema = z.object({ cancelled: z.boolean(), alert: priceAlertSchema.nullable() });
/** `notify.updateAlert`'s answer. */
export const updateAlertReplySchema = z.object({ alert: priceAlertSchema });
/** `notify.setAlertActive`'s answer: the status the alert ended in. */
export const setAlertActiveReplySchema = z.object({ changed: z.boolean(), alert: priceAlertSchema });
/** `notify.deleteAlert`'s answer. `deleted: false` means it was already gone. */
export const deleteAlertReplySchema = z.object({ deleted: z.boolean() });

export const WEBHOOK_CAUSES = [
  'ok',
  'redirect',
  'refused',
  'unavailable',
  'gateway_timeout',
  'timeout',
  'unreachable',
  'private_address',
] as const;
export const webhookAttemptSchema = z.object({
  n: z.number().int().min(1),
  at: date,
  status: z.number().int().nullable(),
  cause: z.enum(WEBHOOK_CAUSES),
  durationMs: z.number().int().min(0),
});

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
  // What happened to this firing on each channel, and on its webhook. A service that does not send them shows no delivery
  // lines.
  deliveries: z.array(notifyDeliverySchema).max(8).optional(),
  webhook: z
    .object({
      status: z.enum(['pending', 'delivered', 'failed']),
      attempts: z.array(webhookAttemptSchema).max(50),
      nextAttemptAt: date.nullable(),
    })
    .nullable()
    .optional(),
});

/** The owner's webhook policy: the ports a webhook may use (null: none can be saved) and the resend delays (null: none). */
export const webhookPolicySchema = z.object({
  ports: z.array(z.number().int().min(1).max(65535)).max(32).nullable(),
  retrySeconds: z.array(z.number().int().min(1)).max(32).nullable(),
  timeoutMs: z.number().int().min(1),
});
export const alertTriggersSchema = z.object({ retentionDays: z.number().int().min(1), items: z.array(alertTriggerSchema).max(200) });

export const alertQuotaSchema = z.object({
  kind: z.literal('price'),
  used: z.number().int().min(0),
  max: z.number().int().min(1).nullable(),
  // The burst auto-stop rule, or null while the owner has not set it. A service that does not send it reads as unknown.
  burst: z
    .object({ windowMinutes: z.number().int().min(1), maxTriggers: z.number().int().min(1) })
    .nullable()
    .optional(),
  // The most conditions one alert may hold, the main one included; null while the owner has not set it.
  maxConditions: z.number().int().min(1).nullable().optional(),
});

/** `notify.createAlerts`'s answer: one active alert per market asked, all or none. */
export const createAlertsReplySchema = z.object({ alerts: z.array(priceAlertSchema).min(1), evaluation: alertEvaluationSchema });

export const watchRuleSchema = z.object({
  id: z.string().guid(),
  listId: z.string().min(1).max(40),
  listName: z.string().min(1).max(40),
  condition: z.enum(ALERT_CONDITIONS),
  targetPrice: z.string().min(1).max(64),
  status: z.enum(['active', 'stopped']),
  markets: z.array(z.string()),
  createdAt: date,
  lastSyncAt: date.nullable(),
  // A code this page does not know reads as one it cannot name, never as "nothing refused".
  lastSyncCode: z.string().nullable(),
});
export const watchRulesSchema = z.object({ items: z.array(watchRuleSchema).max(100) });
/** `notify.createWatchlistAlert`'s answer: the rule and one alert per covered market. */
export const createWatchRuleReplySchema = z.object({ rule: watchRuleSchema, alerts: z.array(priceAlertSchema).min(1) });
/** `notify.stopWatchlistAlert`'s answer. */
export const stopWatchRuleReplySchema = z.object({ rule: watchRuleSchema.nullable() });
