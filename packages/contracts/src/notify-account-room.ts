/**
 * What the account room's notification pages (module `notify`) accept from svc-notify: the inbox and out-of-app
 * preferences, read with the schemas here, and the account room's own checks over the replies of calls that have records
 * (`notify-procedures`): channels, targets, each notification's deliveries, and registering, verifying and removing a
 * target. Browser-safe (zod only). They are stricter than every caller's (each list holds one row per channel); a check
 * against the caller's own user or request stays in the app.
 */
import { z } from 'zod';
import type {
  NOTIFY_CHANNELS,
  NOTIFY_DELIVERIES,
  NOTIFY_MARK_READ,
  NOTIFY_REGISTER_TARGET,
  NOTIFY_TARGETS,
  NOTIFY_VERIFY_TARGET,
} from './notify-procedures.js';
import type { ProcedureOutput } from './procedure.js';

const date = z.string().datetime({ offset: true });
const dated = (value: string) => date.safeParse(value).success;
const datedOrNull = (value: string | null) => value === null || dated(value);
const unique = <T extends { channel: string }>(rows: readonly T[]) => new Set(rows.map((row) => row.channel)).size === rows.length;

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

export const accountNotifyPrefsSchema = z
  .array(z.object({ channel: accountNotifyOutOfAppSchema, muted: z.boolean() }))
  .max(3)
  .refine(unique, 'Duplicate notification preferences');
/** `notify.channels`: one row per channel, so at most four. */
export const accountChannelsHold = (rows: ProcedureOutput<typeof NOTIFY_CHANNELS>): boolean => rows.length <= 4 && unique(rows);
/** `notify.targets`: one non-empty address per out-of-app channel, each confirmation a dated timestamp. */
export const accountTargetsHold = (rows: ProcedureOutput<typeof NOTIFY_TARGETS>): boolean =>
  rows.length <= 3 && unique(rows) && rows.every((row) => row.address.length > 0 && datedOrNull(row.verifiedAt));
/** `notify.deliveries`: one row per channel, each attempt and acceptance a dated timestamp. */
export const accountDeliveriesHold = (rows: ProcedureOutput<typeof NOTIFY_DELIVERIES>): boolean =>
  rows.length <= 4 && unique(rows) && rows.every((row) => datedOrNull(row.attemptedAt) && datedOrNull(row.acceptedAt));
/** `notify.markRead` of one notification marks at most one. */
export const accountMarkedOneHolds = (reply: ProcedureOutput<typeof NOTIFY_MARK_READ>): boolean => reply.marked <= 1;

/** A refusal code, never a six-digit verification code. */
const refusalOrNull = (code: string | null) => code === null || !/^\d{6}$/.test(code);
/** `notify.registerTarget`: a refusal code is never a verification code, and it expires at a dated timestamp. */
export const accountRegisteredHolds = (reply: ProcedureOutput<typeof NOTIFY_REGISTER_TARGET>): boolean =>
  refusalOrNull(reply.code) && dated(reply.expiresAt);
/** `notify.verifyTarget`: a refusal code is never a verification code. */
export const accountVerifiedHolds = (reply: ProcedureOutput<typeof NOTIFY_VERIFY_TARGET>): boolean => refusalOrNull(reply.code);
