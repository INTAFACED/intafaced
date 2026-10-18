import { z } from 'zod';
import { authoredRefusal, type ApiClient, type ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { useApi, useSession } from '../session/session';
import {
  buildTracking,
  certDefinition,
  certGrant,
  certProgressRow,
  completionPage,
  type CompletionRow,
  lessonCatalogue,
  type Tracking,
  type LessonSummary,
} from './academy-lms';

/** The service caps a page at 200 and a completion is one per curriculum lesson, so more than a few pages is not a real answer. */
const COMPLETION_PAGE = 200;
const COMPLETION_MAX_PAGES = 5;
/** Every lesson completion on this account, following the service's cursor. */
export async function readCompletions(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<CompletionRow[]>> {
  const rows: CompletionRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < COMPLETION_MAX_PAGES; page++) {
    const result = await api.query('academy', 'myCompletions', { limit: COMPLETION_PAGE, ...(cursor ? { cursor } : {}) }, completionPage, {
      signal,
    });
    if (!result.ok) return result;
    rows.push(...result.data.items);
    if (!result.data.nextCursor) return { ok: true, data: rows };
    cursor = result.data.nextCursor;
  }
  return authoredRefusal('invalid_response', { key: 'unverifiedRead' });
}

/**
 * One read of everything Academy knows about this account's learning: the published lessons, every
 * certificate definition, this account's progress against each, the certificates it holds and the lessons it completed.
 * Failure in any part fails the whole read, so a screen never shows progress built from half the facts.
 */
export function useAcademyTracking() {
  const api = useApi();
  const { userId } = useSession();
  return useResource<{ lessons: LessonSummary[]; tracking: Tracking }>(
    async (signal): Promise<ApiResult<{ lessons: LessonSummary[]; tracking: Tracking }>> => {
      const lessons = await api.query('academy', 'curriculum', { limit: 200 }, lessonCatalogue, { signal });
      if (!lessons.ok) return lessons;
      const definitions = await api.query('academy', 'certDefinitions', undefined, z.array(certDefinition), { signal });
      if (!definitions.ok) return definitions;
      const rows = await Promise.all(
        definitions.data.map((definition) => api.query('academy', 'certProgress', { certId: definition.id }, certProgressRow, { signal })),
      );
      const progress: z.infer<typeof certProgressRow>[] = [];
      for (const [index, row] of rows.entries()) {
        if (!row.ok) return row;
        // A progress answer for another account or certificate is not this account's progress.
        if (row.data.userId !== userId || row.data.certId !== definitions.data[index]!.id)
          return authoredRefusal('invalid_response', { key: 'loadFailed' });
        progress.push(row.data);
      }
      const grants = await api.query('academy', 'myCerts', { limit: 200 }, z.array(certGrant), { signal });
      if (!grants.ok) return grants;
      if (grants.data.some((grant) => grant.userId !== userId)) return authoredRefusal('invalid_response', { key: 'loadFailed' });
      const completions = await readCompletions(api, signal);
      if (!completions.ok) return completions;
      return {
        ok: true,
        data: { lessons: lessons.data, tracking: buildTracking(definitions.data, progress, grants.data, completions.data) },
      };
    },
    `academy-tracking:${userId}`,
  );
}
