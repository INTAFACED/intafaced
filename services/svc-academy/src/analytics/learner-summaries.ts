/**
 * AC-analytics-01 (J-academy-16 #2): per-learner summaries for the founder console. One row per learner with an open
 * enrolment (a curriculum path or a course staff made): how many open enrolments they hold, how many items they have
 * completed, and when they were last active (their newest lesson read, completion or enrolment). With a tag, only the
 * learners who carry it. Pages run in learner id order; the page size is an owner value
 * (`ACADEMY_LEARNER_SUMMARIES_PAGE_SIZE`): blank refuses `academy.learner_summaries_list_limit_unset`. Read only.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { AcademyLearnerSummaries, AcademyLearnerSummary } from '@intafaced/contracts';
import { defineRefusals, requireSetting } from '@intafaced/service-kit';

export const analyticsRefusals = defineRefusals('AcademyAnalyticsError', {
  'academy.learner_summaries_list_limit_unset': 'PRECONDITION_FAILED',
  'academy.report_tasks_list_limit_unset': 'PRECONDITION_FAILED',
  'academy.report_retention_unset': 'PRECONDITION_FAILED',
  'academy.report_limit_unset': 'PRECONDITION_FAILED',
  'academy.report_sweep_unset': 'PRECONDITION_FAILED',
  'academy.report_too_large': 'PRECONDITION_FAILED',
  'academy.report_out_of_order': 'CONFLICT',
  'academy.report_not_found': 'NOT_FOUND',
  'academy.report_not_ready': 'CONFLICT',
  'academy.report_not_abortable': 'CONFLICT',
  'academy.report_expired': 'PRECONDITION_FAILED',
});

type Db = Sql | TransactionSql;

/** The learners with an open enrolment, in id order, after `after`, filtered by `tag`; at most `limit`. */
export async function learnerIds(sql: Db, input: { tag: string | null; after: string | null; limit: number }): Promise<string[]> {
  const rows = await sql<Array<{ user_id: string }>>`
    SELECT user_id FROM (
      SELECT user_id FROM academy.cert_enrollments WHERE left_at IS NULL
      UNION SELECT user_id FROM academy.course_enrolments WHERE left_at IS NULL
    ) people
    WHERE (${input.tag}::text IS NULL
           OR EXISTS (SELECT 1 FROM academy.learner_tags t WHERE t.user_id = people.user_id AND t.tag = ${input.tag}))
      AND (${input.after}::uuid IS NULL OR user_id > ${input.after}::uuid)
    ORDER BY user_id
    LIMIT ${input.limit}
  `;
  return rows.map((r) => r.user_id);
}

/** The summary of each learner in `users`, in that order. */
export async function summariesOf(sql: Db, users: readonly string[]): Promise<AcademyLearnerSummary[]> {
  if (users.length === 0) return [];
  const ids = [...users];
  const [counts, tags] = await Promise.all([
    sql<Array<{ user_id: string; enrolments: number; items: number; last_active: Date | null }>>`
      SELECT u.user_id,
        (SELECT count(*) FROM academy.cert_enrollments e WHERE e.user_id = u.user_id AND e.left_at IS NULL)::int
          + (SELECT count(*) FROM academy.course_enrolments c WHERE c.user_id = u.user_id AND c.left_at IS NULL)::int AS enrolments,
        (SELECT count(*) FROM academy.cert_item_completions i WHERE i.user_id = u.user_id)::int AS items,
        GREATEST(
          (SELECT max(touched_at) FROM academy.learning_touches t WHERE t.user_id = u.user_id),
          (SELECT max(completed_at) FROM academy.cert_item_completions i WHERE i.user_id = u.user_id),
          (SELECT max(enrolled_at) FROM academy.cert_enrollments e WHERE e.user_id = u.user_id),
          (SELECT max(enrolled_at) FROM academy.course_enrolments c WHERE c.user_id = u.user_id)
        ) AS last_active
      FROM unnest(${ids}::uuid[]) AS u(user_id)
    `,
    sql<Array<{ user_id: string; tag: string }>>`
      SELECT user_id, tag FROM academy.learner_tags WHERE user_id = ANY(${ids}::uuid[]) ORDER BY tag
    `,
  ]);
  const byUser = new Map(counts.map((c) => [c.user_id, c]));
  return ids.map((userId) => {
    const c = byUser.get(userId);
    return {
      userId,
      enrolments: c?.enrolments ?? 0,
      itemsCompleted: c?.items ?? 0,
      lastActiveAt: c?.last_active ? c.last_active.toISOString() : null,
      tags: tags.filter((t) => t.user_id === userId).map((t) => t.tag),
    };
  });
}

export class LearnerSummaries {
  /** `pageSize` is `ACADEMY_LEARNER_SUMMARIES_PAGE_SIZE` as read from env: null when blank. */
  constructor(
    private readonly sql: Sql,
    private readonly pageSize: number | null,
  ) {}

  async page(input: { tag?: string | undefined; after?: string | undefined }): Promise<AcademyLearnerSummaries> {
    const pageSize = requireSetting(this.pageSize, analyticsRefusals, 'academy.learner_summaries_list_limit_unset');
    const tag = input.tag ?? null;
    const ids = await learnerIds(this.sql, { tag, after: input.after ?? null, limit: pageSize + 1 });
    const page = ids.slice(0, pageSize);
    return {
      tag,
      pageSize,
      rows: await summariesOf(this.sql, page),
      next: ids.length > pageSize ? page[page.length - 1]! : null,
    };
  }
}
