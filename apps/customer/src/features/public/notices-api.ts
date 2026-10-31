// hand-declared-ok: svc-notify has no browser-safe response schema in packages/contracts; this reuses the entry shape that mirrors its router output
/** The public notice feed (module `notify`, tRPC through the edge). Both procedures are public, so they work signed out. */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { entrySchema, type ChangelogEntry } from '../developers/developers-api';

export type Notice = ChangelogEntry;

export const NOTICE_LIST_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isNoticeId = (value: string | null | undefined): value is string => !!value && UUID.test(value);

/** Changelog entries have their own page (/developers/changelog), so the feed keeps every other kind. */
export const feedNotices = (rows: readonly Notice[]): Notice[] => rows.filter((row) => row.kind !== 'changelog');

export const readNotices = (api: ApiClient, signal?: AbortSignal): Promise<ApiResult<Notice[]>> =>
  api.query('notify', 'notify.notices', { limit: NOTICE_LIST_LIMIT }, z.array(entrySchema).max(NOTICE_LIST_LIMIT), { signal });

/** The latest `limit` published announcements, newest first, scheduled and closed ones included (Home's strip filters them). */
export const readLatestAnnouncements = (api: ApiClient, limit: number, signal?: AbortSignal): Promise<ApiResult<Notice[]>> =>
  api.query('notify', 'notify.notices', { kind: 'announcement', limit }, z.array(entrySchema).max(limit), { signal });

export type MaintenancePhase = 'scheduled' | 'in_progress' | 'completed' | 'end_unset' | 'time_unset';

/**
 * Where a maintenance window stands at `now`, from its published start and end only: before the start it is scheduled,
 * after the end it is completed, in between in progress. A window with no start, or a time that does not read as one,
 * says its time is not set; a started window with no end says so, rather than "in progress" for ever. Not a
 * maintenance notice: null.
 */
export function maintenancePhase(notice: Pick<Notice, 'kind' | 'startsAt' | 'endsAt'>, now: number): MaintenancePhase | null {
  if (notice.kind !== 'maintenance') return null;
  const start = notice.startsAt ? Date.parse(notice.startsAt) : NaN;
  const end = notice.endsAt ? Date.parse(notice.endsAt) : null;
  if (Number.isNaN(start) || (end !== null && Number.isNaN(end))) return 'time_unset';
  if (start > now) return 'scheduled';
  if (end === null) return 'end_unset';
  return end <= now ? 'completed' : 'in_progress';
}

export const NOTICE_NOT_FOUND = 'notify.notice_not_found';

/** A notice the feed does not hold (missing, a draft, withdrawn) is an answer, `null`, not a failed read. */
export const readNotice = async (api: ApiClient, id: string, signal?: AbortSignal): Promise<ApiResult<Notice | null>> => {
  const result = await api.query('notify', 'notify.notice', { id }, entrySchema, { signal });
  return !result.ok && result.code === NOTICE_NOT_FOUND ? { ok: true, data: null } : result;
};

const noticeStatusSchema = z.object({ incidents: z.array(entrySchema), maintenance: z.array(entrySchema) });
export type NoticeStatus = z.infer<typeof noticeStatusSchema>;

/** Open published incidents and maintenance windows. Public, so it works signed out. */
export const readNoticeStatus = (api: ApiClient, signal?: AbortSignal): Promise<ApiResult<NoticeStatus>> =>
  api.query('notify', 'notify.noticeStatus', undefined, noticeStatusSchema, { signal });
