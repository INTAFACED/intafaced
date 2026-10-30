/**
 * AC-assignments-04, first part — the grading policy and the gradebook of a course staff made.
 *
 * Staff save the course's types over the revision read: each a name, a decimal weight, how many lowest scores to drop and
 * the assignments and quizzes it holds. The weights must add up to exactly 1 (`academy.weights_invalid`, naming the sum);
 * an item that is not one of the course's assignments or graded quizzes, an item in two types, or a type that would drop
 * every score refuses `academy.grading_policy_invalid`. The gradebook is worked out on each read from stored grades
 * (course-gradebook-math.ts): nothing here stores a learner's score. No money moves.
 */
import type { Sql, TransactionSql } from 'postgres';
import { formatAmount, parseAmount, SCALE } from '@intafaced/ledger-client';
import type { AcademyCourseGradebook, AcademyGradeType, AcademySaveGradingPolicyInput } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { fractionOf, fractionText, typeAverage, weightedTotal, weightSum, type Fraction } from './course-gradebook-math.js';
import { effectiveScoreSql } from './course-quiz-trail.js';

type Db = Sql | TransactionSql;
type ItemRow = { id: string; title: string; kind: 'assignment' | 'quiz'; scoring_policy: string | null };
type Cell = { state: 'graded' | 'pending' | 'not_attempted'; score: Fraction | null };

/** A type as stored and read back: weights in canonical form, item ids in order. */
const normal = (types: readonly AcademyGradeType[]): AcademyGradeType[] =>
  types.map((t) => ({
    name: t.name.trim(),
    weight: formatAmount(parseAmount(t.weight)),
    dropLowest: t.dropLowest,
    itemIds: [...t.itemIds].sort(),
  }));

/** A quiz's score from its graded attempts by the quiz's scoring policy; one attempt allowed has no policy. */
function quizScore(policy: string | null, attempts: ReadonlyArray<{ number: number; score: Fraction }>): Fraction {
  const byNumber = [...attempts].sort((a, b) => a.number - b.number);
  switch (policy) {
    case 'latest':
      return byNumber[byNumber.length - 1]!.score;
    case 'first':
      return byNumber[0]!.score;
    case 'average':
      return byNumber.reduce((t, a) => t + a.score, 0n) / BigInt(byNumber.length);
    default:
      return byNumber.reduce((best, a) => (a.score > best ? a.score : best), byNumber[0]!.score);
  }
}

export class CourseGradebook {
  constructor(private readonly sql: Sql) {}

  /** The policy, the course's graded items and a row per enrolled learner. */
  async view(courseId: string): Promise<AcademyCourseGradebook> {
    return this.sql.begin('isolation level repeatable read read only', (tx) => this.viewIn(tx, courseId));
  }

  async savePolicy(input: AcademySaveGradingPolicyInput & { operatorId: string; now: Date }): Promise<AcademyCourseGradebook> {
    return this.sql.begin(async (tx) => {
      const [course] = await tx`SELECT id FROM academy.courses WHERE id = ${input.courseId} FOR UPDATE`;
      if (!course) throw new AcademyError('no course has that id', 'academy.course_not_found');
      const [stored] = await tx<Array<{ revision: number; types: AcademyGradeType[] }>>`
        SELECT revision, types FROM academy.course_grading_policies WHERE course_id = ${input.courseId}
      `;
      const revision = stored?.revision ?? 0;
      if (revision !== input.revision)
        throw new AcademyError(`the grading policy is at revision ${revision}, not ${input.revision}`, 'academy.revision_stale');
      const types = normal(input.types);
      const sum = weightSum(types.map((t) => t.weight));
      if (sum !== SCALE) {
        throw new AcademyError(
          `academy.weights_invalid sum=${formatAmount(sum)}: the weights must add up to exactly 1`,
          'academy.weights_invalid',
        );
      }
      const gradable = new Set((await this.items(tx, input.courseId)).map((i) => i.id));
      const seen = new Set<string>();
      const names = new Set<string>();
      for (const t of types) {
        if (names.has(t.name.toLowerCase())) throw new AcademyError(`two types are named ${t.name}`, 'academy.grading_policy_invalid');
        names.add(t.name.toLowerCase());
        if (t.dropLowest >= t.itemIds.length)
          throw new AcademyError(`${t.name} would drop every score it holds`, 'academy.grading_policy_invalid');
        for (const id of t.itemIds) {
          if (!gradable.has(id))
            throw new AcademyError(`item ${id} is not a graded assignment or quiz of this course`, 'academy.grading_policy_invalid');
          if (seen.has(id)) throw new AcademyError(`item ${id} is in two types`, 'academy.grading_policy_invalid');
          seen.add(id);
        }
      }
      if (stored && JSON.stringify(normal(stored.types)) === JSON.stringify(types)) return this.viewIn(tx, input.courseId);
      const next = revision + 1;
      await tx`
        INSERT INTO academy.course_grading_policies (course_id, revision, types, reason, set_by, set_at)
        VALUES (${input.courseId}, ${next}, ${tx.json(types as never)}, ${input.reason}, ${input.operatorId}, ${input.now})
        ON CONFLICT (course_id) DO UPDATE SET revision = EXCLUDED.revision, types = EXCLUDED.types, reason = EXCLUDED.reason,
          set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
      `;
      await tx`
        INSERT INTO academy.course_grading_policy_events (course_id, revision, types, reason, actor_id, at)
        VALUES (${input.courseId}, ${next}, ${tx.json(types as never)}, ${input.reason}, ${input.operatorId}, ${input.now})
      `;
      return this.viewIn(tx, input.courseId);
    });
  }

  /** The course's assignments with a brief and its graded quizzes (not surveys), in outline order. */
  private items(sql: Db, courseId: string) {
    return sql<ItemRow[]>`
      SELECT i.id, i.title, i.kind, q.scoring_policy
      FROM academy.course_items i
      JOIN academy.course_sections s ON s.id = i.section_id
      LEFT JOIN academy.course_assignments a ON a.item_id = i.id
      LEFT JOIN academy.course_quizzes q ON q.item_id = i.id
      WHERE i.course_id = ${courseId}
        AND ((i.kind = 'assignment' AND a.item_id IS NOT NULL) OR (i.kind = 'quiz' AND q.item_id IS NOT NULL AND q.kind = 'quiz'))
      ORDER BY s.position, i.position
    `;
  }

  /** The gradebook read on a connection the caller holds (a report reads it inside its own transaction). */
  async viewIn(sql: Db, courseId: string): Promise<AcademyCourseGradebook> {
    const [course] = await sql`SELECT id FROM academy.courses WHERE id = ${courseId}`;
    if (!course) throw new AcademyError('no course has that id', 'academy.course_not_found');
    const [policy] = await sql<Array<{ revision: number; types: AcademyGradeType[]; set_by: string; set_at: Date; reason: string }>>`
      SELECT revision, types, set_by, set_at, reason FROM academy.course_grading_policies WHERE course_id = ${courseId}
    `;
    const items = await this.items(sql, courseId);
    const learners = await sql<Array<{ user_id: string }>>`
      SELECT user_id FROM academy.course_enrolments WHERE course_id = ${courseId} AND left_at IS NULL ORDER BY enrolled_at, user_id
    `;
    // Each learner's newest hand-in and its newest grade, as the learner's own grades page reads it: a newer hand-in
    // waiting for a grade is pending, never the older grade.
    const handIns = await sql<Array<{ item_id: string; user_id: string; state: string; score: string | null; points: string | null }>>`
      SELECT DISTINCT ON (s.item_id, s.user_id) s.item_id, s.user_id, s.state, g.score::text AS score, g.points::text AS points
      FROM academy.assignment_submissions s
      JOIN academy.course_items i ON i.id = s.item_id
      LEFT JOIN LATERAL (
        SELECT score, points FROM academy.assignment_grade_events WHERE submission_id = s.id ORDER BY n DESC LIMIT 1
      ) g ON TRUE
      WHERE i.course_id = ${courseId}
      ORDER BY s.item_id, s.user_id, s.version DESC
    `;
    const attempts = await sql<
      Array<{ item_id: string; user_id: string; number: number; state: string; score: number | null; max_score: number | null }>
    >`
      SELECT t.item_id, t.user_id, t.number, t.state, ${effectiveScoreSql(sql)} AS score, t.max_score
      FROM academy.course_quiz_attempts t JOIN academy.course_items i ON i.id = t.item_id
      WHERE i.course_id = ${courseId}
    `;

    const cells = new Map<string, Cell>();
    const key = (itemId: string, userId: string) => `${itemId}:${userId}`;
    for (const h of handIns) {
      const score = h.score !== null && h.points !== null ? fractionOf(h.score, h.points) : null;
      if (score !== null) cells.set(key(h.item_id, h.user_id), { state: 'graded', score });
      else if (h.state !== 'draft' && h.state !== 'withdrawn') cells.set(key(h.item_id, h.user_id), { state: 'pending', score: null });
    }
    const quizPolicy = new Map(items.filter((i) => i.kind === 'quiz').map((i) => [i.id, i.scoring_policy]));
    const graded = new Map<string, Array<{ number: number; score: Fraction }>>();
    for (const a of attempts) {
      if (!quizPolicy.has(a.item_id)) continue;
      const k = key(a.item_id, a.user_id);
      const score = a.state === 'graded' && a.score !== null && a.max_score ? fractionOf(String(a.score), String(a.max_score)) : null;
      if (score !== null) (graded.get(k) ?? graded.set(k, []).get(k)!).push({ number: a.number, score });
      else if (a.state === 'pending_review' && !cells.has(k)) cells.set(k, { state: 'pending', score: null });
    }
    for (const [k, list] of graded) {
      const itemId = k.slice(0, k.indexOf(':'));
      cells.set(k, { state: 'graded', score: quizScore(quizPolicy.get(itemId) ?? null, list) });
    }

    const types = policy ? normal(policy.types) : [];
    return {
      courseId,
      policy: policy
        ? { revision: policy.revision, types, setBy: policy.set_by, setAt: policy.set_at.toISOString(), reason: policy.reason }
        : null,
      items: items.map((i) => ({ itemId: i.id, title: i.title, kind: i.kind })),
      learners: learners.map(({ user_id: userId }) => {
        const cellOf = (itemId: string): Cell => cells.get(key(itemId, userId)) ?? { state: 'not_attempted', score: null };
        const byType = types.map((t) => {
          const scored = t.itemIds.flatMap((itemId) => {
            const c = cellOf(itemId);
            return c.state === 'graded' && c.score !== null ? [{ itemId, score: c.score }] : [];
          });
          const avg = typeAverage(scored, t.dropLowest);
          return { name: t.name, weight: t.weight, ...avg };
        });
        const total = policy ? weightedTotal(byType) : null;
        return {
          userId,
          items: items.map((i) => {
            const c = cellOf(i.id);
            return { itemId: i.id, state: c.state, score: c.score === null ? null : fractionText(c.score) };
          }),
          types: byType.map((t) => ({
            name: t.name,
            average: t.average === null ? null : fractionText(t.average),
            counted: t.counted,
            dropped: t.dropped,
          })),
          total: total === null ? null : fractionText(total),
        };
      }),
    };
  }
}
