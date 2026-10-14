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
