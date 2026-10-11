import { bigint, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk } from '@intafaced/db';
import type { GuestNotificationSendInput, GuestNotificationReceipt } from '@intafaced/contracts';

/**
 * svc-notify schema — the inbox, who may be contacted, and what happened.
 *
 * Doctrine §2: this schema is the only one this service may touch. No balances,
 * no money columns, no references into another service's tables. In particular
 * `channel_targets` is NOT a mirror of `identity.users.email` — svc-notify may
 * not read that table, and a login address is not consent to be texted anyway.
 */

export const schema = pgSchema('notify');

/** Prospects remain separate from verified platform channel targets. */
export const guestNotifications = schema.table('guest_notifications', {
  id: pk(),
  businessKey: text('business_key').notNull().unique(),
  fingerprint: text('fingerprint').notNull(),
  submissionId: uuid('submission_id').notNull(),
  payload: jsonb('payload').$type<GuestNotificationSendInput>(),
  erasedAt: timestamp('erased_at', { withTimezone: true, mode: 'date' }),
  status: text('status').$type<GuestNotificationReceipt['status']>().notNull(),
  code: text('code').$type<GuestNotificationReceipt['code']>(),
  reference: text('reference'),
  attemptedAt: timestamp('attempted_at', { withTimezone: true, mode: 'date' }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
  claimToken: uuid('claim_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});
export const guestErasedSubmissions = schema.table('guest_erased_submissions', {
  submissionId: uuid('submission_id').primaryKey(),
  erasedAt: timestamp('erased_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});
export const guestErasureRequests = schema.table('guest_erasure_requests', {
  requestId: uuid('request_id').primaryKey(),
  submissionId: uuid('submission_id').notNull(),
  result: jsonb('result').notNull(),
});
export const guestAddressRateWindows = schema.table(
  'guest_address_rate_windows',
  {
    addressHash: text('address_hash').notNull(),
    windowStart: bigint('window_start', { mode: 'bigint' }).notNull(),
    attempts: integer('attempts').notNull(),
  },
  (table) => [primaryKey({ columns: [table.addressHash, table.windowStart] })],
);

export const notifications = schema.table('notifications', {
  id: pk(),
  userId: text('user_id').notNull(),
  kind: text('kind').notNull(),
  titleKey: text('title_key').notNull(),
  bodyKey: text('body_key').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
  href: text('href'),
  severity: text('severity').$type<'info' | 'action' | 'critical'>().notNull().default('info'),
  readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
  sourceSubject: text('source_subject').notNull(),
  sourceIdempotencyKey: text('source_idempotency_key').notNull(),
  createdAt: createdAt(),
});

/**
 * An address the user gave us and confirmed.
 *
 * `verified_at IS NULL` means nothing is ever sent here. `verify_token_hash`
 * holds a SHA-256 of the code, never the code — a support engineer reading this
 * table must not be able to confirm somebody else's phone number.
 */
export const channelTargets = schema.table(
  'channel_targets',
  {
    userId: text('user_id').notNull(),
    channel: text('channel').$type<'email' | 'push' | 'sms'>().notNull(),
    address: text('address').notNull(),
    locale: text('locale').notNull().default('en'),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    verifyTokenHash: text('verify_token_hash'),
    verifyExpiresAt: timestamp('verify_expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channel] })],
);

/**
 * One row per (notification, channel) — the attempt AND the outcome.
 *
 * `attempted_at` and `accepted_at` are separate columns on purpose, and this is
 * the single most important line in the schema. "We tried and the gateway was
 * down" (attempted, not accepted) and "we never had an address" (neither) and
 * "a transport took it" (both) are three different facts about a margin call, and
 * a borrower disputing a liquidation is entitled to know which one applies.
 * svc-bank keeps `notified_at` apart from `called_at` for the same reason; this
 * is that discipline one layer out.
 *
 * The unique index is the idempotency guard: at-least-once bus delivery means a
 * redelivered event tries to send again, and the claim on this key is what turns
 * the second attempt into a no-op instead of a second email.
 */
export const deliveries = schema.table(
  'deliveries',
  {
    id: pk(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    channel: text('channel').$type<'inapp' | 'email' | 'push' | 'sms'>().notNull(),
    status: text('status').$type<'pending' | 'accepted' | 'refused' | 'failed' | 'abandoned'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    attemptedAt: timestamp('attempted_at', { withTimezone: true, mode: 'date' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    /** Exclusive claim window — see 0004_notify_delivery_claim_lease.sql. */
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
    refusalCode: text('refusal_code'),
    detail: text('detail'),
    reference: text('reference'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('deliveries_notification_channel_idx').on(t.notificationId, t.channel)],
);

/**
 * Out-of-app mute prefs. Presence of a row = muted for info/action.
 * Critical severity ignores mute in dispatch — this table has no severity column
 * on purpose (product answer: users cannot silence critical).
 */
export const channelMutes = schema.table(
  'channel_mutes',
  {
    userId: text('user_id').notNull(),
    channel: text('channel').$type<'email' | 'push' | 'sms'>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channel] })],
);

/**
 * Shared register/verify rate windows. One row per (user, channel, op).
 * `hit_count` is takes inside the open window; expired windows reset on take.
 * Production claim path: SELECT … FOR UPDATE (see PostgresTargetRateLimiter).
 */
export const targetRateWindows = schema.table(
  'target_rate_windows',
  {
    userId: text('user_id').notNull(),
    channel: text('channel').$type<'email' | 'push' | 'sms'>().notNull(),
    op: text('op').$type<'register' | 'verify'>().notNull(),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
    hitCount: integer('hit_count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channel, t.op] })],
);

/**
 * Price-alert watchlists (v22.alerts MVP). target_price is text — decimal string.
 * See drizzle/0006_notify_price_alerts.sql.
 */
export const priceAlerts = schema.table('price_alerts', {
  id: pk(),
  userId: text('user_id').notNull(),
  marketId: text('market_id').notNull(),
  kind: text('kind').$type<'price' | 'funding' | 'liquidation_proximity' | 'whale'>().notNull().default('price'),
  direction: text('direction').$type<'above' | 'below'>().notNull(),
  targetPrice: text('target_price').notNull(),
  status: text('status').$type<'active' | 'fired' | 'cancelled'>().notNull().default('active'),
  firedAt: timestamp('fired_at', { withTimezone: true, mode: 'date' }),
  createdAt: createdAt(),
});

export type NotificationRow = typeof notifications.$inferSelect;
export type ChannelTargetRow = typeof channelTargets.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type ChannelMuteRow = typeof channelMutes.$inferSelect;
export type TargetRateWindowRow = typeof targetRateWindows.$inferSelect;
export type PriceAlertRow = typeof priceAlerts.$inferSelect;
