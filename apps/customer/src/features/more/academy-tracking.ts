import { authoredRefusal, type ApiClient, type ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import {
  ACADEMY_CERT_DEFINITIONS,
  ACADEMY_CERT_PROGRESS,
  ACADEMY_CURRICULUM,
  type AcademyCertProgress,
} from '@intafaced/contracts/academy-learner-procedures';
import { useApi, useSession } from '../session';
import { buildTracking, type CompletionRow, type Tracking, type LessonSummary } from './academy-lms';
import { ACADEMY_MY_COMPLETIONS } from '@intafaced/contracts/academy-my-completions-procedures';
import { ACADEMY_MY_CERTS } from '@intafaced/contracts/academy-my-certs-procedures';
import { academyAssignmentViewSchema, academyReviewStateSchema } from '@intafaced/contracts/academy-courses';

/** The service caps a page at 200 and a completion is one per curriculum lesson, so more than a few pages is not a real answer. */
const COMPLETION_PAGE = 200;
const COMPLETION_MAX_PAGES = 5;
/** Every lesson completion on this account, following the service's cursor. */
export async function readCompletions(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<CompletionRow[]>> {
  const rows: CompletionRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < COMPLETION_MAX_PAGES; page++) {
    const result = await api.call(
      ACADEMY_MY_COMPLETIONS,
      { limit: COMPLETION_PAGE, ...(cursor ? { cursor } : {}) },
      {
        signal,
      },
    );
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
      const lessons = await api.call(ACADEMY_CURRICULUM, { limit: 200 }, { signal, accept: (rows) => rows.length <= 200 });
      if (!lessons.ok) return lessons;
      const definitions = await api.call(ACADEMY_CERT_DEFINITIONS, undefined, { signal });
      if (!definitions.ok) return definitions;
      const rows = await Promise.all(
        definitions.data.map((definition) => api.call(ACADEMY_CERT_PROGRESS, { certId: definition.id }, { signal })),
      );
      const progress: AcademyCertProgress[] = [];
      for (const [index, row] of rows.entries()) {
        if (!row.ok) return row;
        // A progress answer for another account or certificate is not this account's progress.
        if (row.data.userId !== userId || row.data.certId !== definitions.data[index]!.id)
          return authoredRefusal('invalid_response', { key: 'loadFailed' });
        progress.push(row.data);
      }
      const grants = await api.call(ACADEMY_MY_CERTS, { limit: 200 }, { signal });
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

/**
 * The assignment page's Academy calls, kept in one place: these calls have no record yet (docs/agents/shape.md rule 1),
 * and the room on the flow template calls them through here.
 */
export const academyAssignmentCalls = {
  read: (api: ApiClient, itemId: string, signal?: AbortSignal) =>
    api.query('academy', 'assignment', { itemId }, academyAssignmentViewSchema, { signal }),
  submit: (api: ApiClient, input: { itemId: string; version: number; text: string | null; fileId: string | null }) =>
    api.mutate('academy', 'submitAssignment', input, academyAssignmentViewSchema),
  markRead: (api: ApiClient, input: { itemId: string; version: number; n: number }) =>
    api.mutate('academy', 'markFeedbackRead', input, academyAssignmentViewSchema),
  review: (api: ApiClient, input: { itemId: string; taskId: string; marks: string[] }) =>
    api.mutate('academy', 'submitPeerReview', input, academyReviewStateSchema),
};
