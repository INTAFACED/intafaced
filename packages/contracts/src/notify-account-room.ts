/**
 * What svc-notify answers the account room's notification pages (module `notify`): the inbox, channels, out-of-app
 * preferences and targets, each notification's deliveries, and registering, verifying and removing a target. Browser-safe
 * (zod only). These are the account pages' readings, stricter than `notify-room`'s (each list holds one row per channel);
 * a check against the caller's own user or request stays in the app.
 */
import { z } from 'zod';

const date = z.string().datetime({ offset: true });
const unique = <T extends { channel: string }>(rows: T[]) => new Set(rows.map((row) => row.channel)).size === rows.length;

export const accountNotifyChannelSchema = z.enum(['inapp', 'email', 'push', 'sms']);
export const accountNotifyOutOfAppSchema = z.enum(['email', 'push', 'sms']);

export const accountNotificationSchema = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  titleKey: z.string(),
  bodyKey: z.string(),
  title: z.string(),
  body: z.string(),
  href: z.string().nullable(),
  severity: z.enum(['info', 'action', 'critical']),
  readAt: date.nullable(),
  createdAt: date,
});
/** `notify.list` for a page of `limit` rows. */
export const accountInboxSchema = (limit: number) =>
  z.object({ items: z.array(accountNotificationSchema).max(limit), nextCursor: z.string().guid().nullable() });
/** `notify.markRead` of one notification. */
export const accountMarkedOneSchema = z.object({ marked: z.number().int().min(0).max(1) });

export const accountNotifyPrefsSchema = z
  .array(z.object({ channel: accountNotifyOutOfAppSchema, muted: z.boolean() }))
  .max(3)
  .refine(unique, 'Duplicate notification preferences');
export const accountNotifyChannelsSchema = z
  .array(
    z.object({
      channel: accountNotifyChannelSchema,
      configured: z.boolean(),
      available: z.boolean(),
      reason: z.string().nullable(),
      requires: z.array(z.string()),
      socket: z.string().nullable(),
    }),
  )
  .max(4)
  .refine(unique, 'Duplicate notification channels');
export const accountNotifyTargetSchema = z.object({
  channel: accountNotifyOutOfAppSchema,
  address: z.string().min(1),
  locale: z.string(),
  verifiedAt: date.nullable(),
});
export const accountNotifyTargetsSchema = z.array(accountNotifyTargetSchema).max(3).refine(unique, 'Duplicate notification targets');
export const accountNotifyDeliveriesSchema = z
  .array(
    z.object({
      channel: accountNotifyChannelSchema,
      status: z.enum(['pending', 'accepted', 'refused', 'failed', 'abandoned']),
      attempts: z.number().int().nonnegative(),
      attemptedAt: date.nullable(),
      acceptedAt: date.nullable(),
      refusalCode: z.string().nullable(),
    }),
  )
  .max(4)
  .refine(unique, 'Duplicate notification delivery channels');

/** A refusal code, never a six-digit verification code. */
const targetRefusal = z
  .string()
  .min(1)
  .refine((value) => !/^\d{6}$/.test(value), 'A refusal is not a verification code')
  .nullable();
/** `notify.registerTarget`. */
export const accountTargetRegisteredSchema = z
  .object({ status: z.enum(['sent', 'refused', 'failed']), channel: accountNotifyOutOfAppSchema, code: targetRefusal, expiresAt: date })
  .refine((row) => (row.status === 'refused' ? row.code !== null : row.code === null), 'Invalid registration outcome');
/** `notify.verifyTarget`. */
export const accountTargetVerifiedSchema = z
  .object({ verified: z.boolean(), code: targetRefusal })
  .refine((row) => !row.verified || row.code === null, 'Invalid verification outcome');
/** `notify.removeTarget`. */
export const accountTargetRemovedSchema = z.object({ removed: z.boolean() });
