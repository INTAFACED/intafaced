// hand-declared-ok: svc-notify has no browser-safe response schema in packages/contracts; this reuses the entry shape that mirrors its router output
/** The public notice feed (module `notify`, tRPC through the edge). Both procedures are public, so they work signed out. */
import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { entrySchema, type ChangelogEntry } from '../developers/developers-api';

export type Notice = ChangelogEntry;

export const NOTICE_LIST_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isNoticeId = (value: string | null | undefined): value is string => !!value && UUID.test(value);

/** Changelog entries have their own page (/developers/changelog), so the feed keeps the other three kinds. */
export const feedNotices = (rows: readonly Notice[]): Notice[] => rows.filter((row) => row.kind !== 'changelog');

export const readNotices = (api: ApiClient, signal?: AbortSignal): Promise<ApiResult<Notice[]>> =>
  api.query('notify', 'notify.notices', { limit: NOTICE_LIST_LIMIT }, z.array(entrySchema).max(NOTICE_LIST_LIMIT), { signal });

export const NOTICE_NOT_FOUND = 'notify.notice_not_found';

/** A notice the feed does not hold (missing, a draft, withdrawn) is an answer, `null`, not a failed read. */
export const readNotice = async (api: ApiClient, id: string, signal?: AbortSignal): Promise<ApiResult<Notice | null>> => {
  const result = await api.query('notify', 'notify.notice', { id }, entrySchema, { signal });
  return !result.ok && result.code === NOTICE_NOT_FOUND ? { ok: true, data: null } : result;
};
