/**
 * AC-quizzes-04 — score changes after a quiz attempt is graded: key fixes, rescores and overrides.
 *
 * An attempt row stays as the learner finished it. Every later change to its score is an event in its score trail,
 * numbered per attempt: the points each question earns after it, the total before and after, whether it passes, the
 * reason and who. The score a learner and the gradebook see is the newest event's, or the attempt's own when there is
 * none (`effectiveScoreSql`).
 *
 * - A key fix is a new revision of a published quiz that changes only keys (a choice key, a numeric answer or its
 *   tolerance); anything else, a question added or taken away, or a key cleared refuses `academy.key_fix_invalid`.
 *   Attempts keep their score until a rescore.
 * - A rescore applies the quiz's current keys, question by question (matched by id), to each graded attempt whose own
 *   copy has another key, and writes an event only where the points change: `rescore:<attempt>:<revision>`, once per
 *   attempt and revision. An essay and a question whose key did not change keep the points the trail gave them.
 * - An override sets one question's whole points (0 to its points) on a graded attempt, with a comment and a reason:
 *   `override:<attempt>:<question>:<n>`. The same `n` again answers as stored; another `n` refuses `academy.revision_stale`.
 *
 * Staff see attempts under per-quiz aliases, never the account. No money moves.
 */
import type { Sql, TransactionSql } from 'postgres';
import type {
  AcademyCourseQuizAnswer,
  AcademyCourseQuizAttempts,
  AcademyCourseQuizQuestion,
  AcademyFixCourseQuizKeyInput,
  AcademyOverrideCourseQuizScoreInput,
  AcademyRescoreCourseQuizInput,
  AcademyRescoreCourseQuizResult,
} from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { scoreQuestion } from './course-quiz-score.js';
import { canonical, questionsOf, recordQuizEvent } from './course-quizzes.js';

type Db = Sql | TransactionSql;

type TrailAttempt = {
  id: string;
  item_id: string;
  user_id: string;
  number: number;
  finished_at: Date;
  state: 'pending_review' | 'graded';
  quiz: { questions: AcademyCourseQuizQuestion[]; passMark: number };
  answers: Record<string, AcademyCourseQuizAnswer>;
  essay_points: Record<string, number> | null;
  score: number | null;
  max_score: number | null;
  passed: boolean | null;
};

type EventRow = {
  attempt_id: string;
  n: number;
  kind: 'override' | 'rescore';
  question_id: string | null;
  revision: number | null;
  points: Record<string, number>;
  keys: Record<string, Record<string, unknown>>;
  previous_score: number;
  score: number;
  passed: boolean;
  comment: string | null;
  reason: string;
  actor: string;
  at: Date;
};

/**
 * The score shown for an attempt: its newest score event's, else its own. The query must name the attempts table `t`
 * (`FROM academy.course_quiz_attempts t`). The gradebook reads it; the learner's own attempt and this module's view read
 * the same newest event (`newestEvents`), so every reader agrees.
 */
export const effectiveScoreSql = (sql: Db) => sql`
  coalesce((SELECT e.score FROM academy.course_quiz_score_events e WHERE e.attempt_id = t.id ORDER BY e.n DESC LIMIT 1), t.score)
`;

/** The newest score event of each attempt named, by attempt id. */
export async function newestEvents(sql: Db, attemptIds: readonly string[]): Promise<Map<string, EventRow>> {
  if (attemptIds.length === 0) return new Map();
  const rows = await sql<EventRow[]>`
    SELECT DISTINCT ON (attempt_id) * FROM academy.course_quiz_score_events
    WHERE attempt_id IN ${sql(attemptIds as string[])}
    ORDER BY attempt_id, n DESC
  `;
  return new Map(rows.map((r) => [r.attempt_id, r]));
}

/** A question's key fields: what a key fix may change. Pure. */
export function keyOf(q: AcademyCourseQuizQuestion): Record<string, unknown> {
  switch (q.kind) {
    case 'single':
      return { correctChoiceId: q.correctChoiceId };
    case 'multi':
      return { correctChoiceIds: q.correctChoiceIds };
    case 'numeric':
      return { answer: q.answer, tolerance: q.tolerance };
    case 'essay':
      return {};
  }
}

const hasKey = (q: AcademyCourseQuizQuestion) =>
  q.kind === 'essay' ||
  (q.kind === 'single' ? q.correctChoiceId !== null : q.kind === 'multi' ? q.correctChoiceIds !== null : q.answer !== null);

function withoutKey(q: AcademyCourseQuizQuestion): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...q };
  for (const k of Object.keys(keyOf(q))) delete rest[k];
  return rest;
}

/** The questions a key fix may save over `was`: the same questions, in order, with only keys changed. Pure. */
export function checkKeyFix(was: readonly AcademyCourseQuizQuestion[], next: readonly AcademyCourseQuizQuestion[]): string[] {
  if (was.length !== next.length)
    throw new AcademyError('a key fix keeps every question; add or take one away in a new quiz', 'academy.key_fix_invalid');
  const changed: string[] = [];
  next.forEach((q, i) => {
    const old = was[i]!;
    if (canonical(withoutKey(old)) !== canonical(withoutKey(q)))
      throw new AcademyError(`question ${i + 1} changes more than its key; a key fix changes only keys`, 'academy.key_fix_invalid');
    if (!hasKey(q)) throw new AcademyError(`question ${i + 1} has no key; a key fix sets one`, 'academy.key_fix_invalid');
    if (canonical(keyOf(old)) !== canonical(keyOf(q))) changed.push(q.id);
  });
  if (changed.length === 0) throw new AcademyError('no key changed', 'academy.key_fix_invalid');
  return changed;
}

/** What each question of an attempt earned when it was finished (essays as staff scored them). Pure. */
export function finishedPoints(attempt: Pick<TrailAttempt, 'quiz' | 'answers' | 'essay_points'>): Record<string, number> {
  return Object.fromEntries(
    attempt.quiz.questions.map((q) => [q.id, scoreQuestion(q, attempt.answers[q.id]) ?? attempt.essay_points?.[q.id] ?? 0]),
  );
}

/** The key each question of an attempt was scored on when it was finished: its own copy's. Pure. */
export function finishedKeys(attempt: Pick<TrailAttempt, 'quiz'>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(attempt.quiz.questions.map((q) => [q.id, keyOf(q)]));
}

/**
 * The points and keys after applying `current`'s keys to each question whose key differs from the one its points were
 * last scored on (`keys`). A question an override set keeps its points until its own key changes. Pure.
 */
export function rescoredPoints(
  attempt: Pick<TrailAttempt, 'quiz' | 'answers'>,
  points: Readonly<Record<string, number>>,
  keys: Readonly<Record<string, Record<string, unknown>>>,
  current: readonly AcademyCourseQuizQuestion[],
): { points: Record<string, number>; keys: Record<string, Record<string, unknown>> } {
  const byId = new Map(current.map((q) => [q.id, q]));
  const out = { points: { ...points }, keys: { ...keys } };
  for (const q of attempt.quiz.questions) {
    const now = byId.get(q.id);
    if (!now || now.kind !== q.kind || q.kind === 'essay') continue;
    const key = keyOf(now);
    if (canonical(keys[q.id] ?? keyOf(q)) === canonical(key)) continue;
    out.points[q.id] = scoreQuestion({ ...q, ...key } as AcademyCourseQuizQuestion, attempt.answers[q.id]) ?? 0;
    out.keys[q.id] = key;
  }
  return out;
}

/** Whether a graded attempt's points stand on keys other than the quiz's current ones: a rescore would change it. Pure. */
export function onOlderKeys(
  attempt: Pick<TrailAttempt, 'quiz'>,
  keys: Readonly<Record<string, Record<string, unknown>>>,
  current: readonly AcademyCourseQuizQuestion[],
): boolean {
  const byId = new Map(current.map((q) => [q.id, q]));
  return attempt.quiz.questions.some((q) => {
    const now = byId.get(q.id);
    return Boolean(now && now.kind === q.kind && q.kind !== 'essay' && canonical(keys[q.id] ?? keyOf(q)) !== canonical(keyOf(now)));
  });
}

const total = (points: Readonly<Record<string, number>>) => Object.values(points).reduce((sum, p) => sum + p, 0);

const ATTEMPT = (sql: Db) => sql`
  t.id, t.item_id, t.user_id, t.number, t.finished_at, t.state, t.quiz, t.answers, t.essay_points, t.score, t.max_score, t.passed
`;

export class CourseQuizTrail {
  constructor(private readonly sql: Sql) {}

  /** A key fix: the quiz's next revision with only keys changed, still published. Attempts keep their score. */
  async fixKey(input: AcademyFixCourseQuizKeyInput & { operatorId: string; now: Date }): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [quiz] = await tx<Array<{ revision: number; state: string; kind: string; questions: AcademyCourseQuizQuestion[] }>>`
        SELECT q.revision, q.state, q.kind, q.questions FROM academy.course_quizzes q
        JOIN academy.course_items i ON i.id = q.item_id AND i.kind = 'quiz'
        WHERE q.item_id = ${input.itemId}
        FOR UPDATE OF q
      `;
      if (!quiz) throw new AcademyError('no quiz with that id', 'academy.quiz_not_found');
      if (quiz.kind !== 'quiz' || quiz.state !== 'published')
        throw new AcademyError('only a published graded quiz is fixed; a draft is saved', 'academy.key_fix_invalid');
      if (quiz.revision !== input.revision)
        throw new AcademyError(`the quiz is at revision ${quiz.revision}, not ${input.revision}`, 'academy.revision_stale');
      checkKeyFix(questionsOf(quiz), input.questions);
      await tx`
        UPDATE academy.course_quizzes
        SET revision = ${quiz.revision + 1}, questions = ${tx.json(input.questions as never)}, saved_by = ${input.operatorId},
            saved_at = ${input.now}
        WHERE item_id = ${input.itemId}
      `;
      await recordQuizEvent(tx, input.itemId, quiz.revision + 1, 'key_fixed', input.reason, input.operatorId, input.now);
    });
  }

  /** Apply the current keys to every graded attempt they change, once per attempt and revision. */
  async rescore(input: AcademyRescoreCourseQuizInput & { operatorId: string; now: Date }): Promise<AcademyRescoreCourseQuizResult> {
    const out = await this.sql.begin(async (tx) => {
      const [quiz] = await tx<Array<{ revision: number; kind: string; questions: AcademyCourseQuizQuestion[] }>>`
        SELECT q.revision, q.kind, q.questions FROM academy.course_quizzes q WHERE q.item_id = ${input.itemId} FOR UPDATE
      `;
      if (!quiz || quiz.kind !== 'quiz') throw new AcademyError('no graded quiz with that id', 'academy.quiz_not_found');
      const current = questionsOf(quiz);
      const attempts = await tx<Array<TrailAttempt & { alias: number }>>`
        SELECT ${ATTEMPT(tx)}, a.alias FROM academy.course_quiz_attempts t
        JOIN (SELECT user_id, row_number() OVER (ORDER BY min(started_at), user_id)::int AS alias
              FROM academy.course_quiz_attempts WHERE item_id = ${input.itemId} GROUP BY user_id) a USING (user_id)
        WHERE t.item_id = ${input.itemId} AND t.state = 'graded'
        ORDER BY t.id
        FOR UPDATE OF t
      `;
      const rescored: AcademyRescoreCourseQuizResult['rescored'] = [];
      const newest = await newestEvents(
        tx,
        attempts.map((a) => a.id),
      );
      const done = new Set(
        (
          await tx<Array<{ attempt_id: string }>>`
            SELECT e.attempt_id FROM academy.course_quiz_score_events e JOIN academy.course_quiz_attempts t ON t.id = e.attempt_id
            WHERE t.item_id = ${input.itemId} AND e.kind = 'rescore' AND e.revision = ${quiz.revision}
          `
        ).map((r) => r.attempt_id),
      );
      for (const attempt of attempts) {
        if (done.has(attempt.id)) continue;
        const last = newest.get(attempt.id);
        const before = last?.points ?? finishedPoints(attempt);
        const after = rescoredPoints(attempt, before, last?.keys ?? finishedKeys(attempt), current);
        if (canonical(before) === canonical(after.points)) continue;
        const from = last?.score ?? attempt.score ?? total(before);
        const to = total(after.points);
        await tx`
          INSERT INTO academy.course_quiz_score_events
            (attempt_id, n, kind, revision, points, keys, previous_score, score, passed, reason, actor, at)
          VALUES (${attempt.id}, ${(last?.n ?? 0) + 1}, 'rescore', ${quiz.revision}, ${tx.json(after.points)},
                  ${tx.json(after.keys as never)}, ${from}, ${to}, ${to >= attempt.quiz.passMark}, ${input.reason},
                  ${input.operatorId}, ${input.now})
        `;
        rescored.push({ alias: attempt.alias, number: attempt.number, from, to });
      }
      rescored.sort((a, b) => a.alias - b.alias || a.number - b.number);
      return { revision: quiz.revision, rescored };
    });
    return { ...out, attempts: await this.attempts(input.itemId) };
  }

  /** One question's whole points on a graded attempt, as score event `n`; the same `n` again answers as stored. */
  async override(input: AcademyOverrideCourseQuizScoreInput & { operatorId: string; now: Date }): Promise<AcademyCourseQuizAttempts> {
    await this.sql.begin(async (tx) => {
      const [attempt] = await tx<TrailAttempt[]>`
        SELECT ${ATTEMPT(tx)} FROM academy.course_quiz_attempts t WHERE t.id = ${input.attemptId} FOR UPDATE
      `;
      // An attempt on another quiz is not found here, so a score never lands on a quiz the desk is not showing.
      if (!attempt || attempt.item_id !== input.itemId)
        throw new AcademyError('no attempt with that id on this quiz', 'academy.attempt_not_found');
      if (attempt.state !== 'graded')
        throw new AcademyError(`the attempt is ${attempt.state}; score its essays first`, 'academy.attempt_closed');
      const question = attempt.quiz.questions.find((q) => q.id === input.questionId);
      if (!question || input.points > question.points)
        throw new AcademyError('score a question of this attempt, from 0 to its points', 'academy.assessment_invalid');
      const comment = input.comment || null;
      const [stored] = await tx<EventRow[]>`
        SELECT * FROM academy.course_quiz_score_events WHERE attempt_id = ${attempt.id} AND n = ${input.n}
      `;
      if (
        stored &&
        stored.kind === 'override' &&
        stored.question_id === input.questionId &&
        stored.points[input.questionId] === input.points &&
        stored.comment === comment &&
        stored.reason === input.reason &&
        stored.actor === input.operatorId
      )
        return;
      const last = await this.lastEvent(tx, attempt.id);
      if (input.n !== (last?.n ?? 0) + 1)
        throw new AcademyError(
          `the next score change on this attempt is ${(last?.n ?? 0) + 1}, not ${input.n}; read the attempts again`,
          'academy.revision_stale',
        );
      const before = last?.points ?? finishedPoints(attempt);
      const after = { ...before, [input.questionId]: input.points };
      const to = total(after);
      // The override stands on the key in force for its question; a rescore leaves it until that key changes.
      await tx`
        INSERT INTO academy.course_quiz_score_events
          (attempt_id, n, kind, question_id, points, keys, previous_score, score, passed, comment, reason, actor, at)
        VALUES (${attempt.id}, ${input.n}, 'override', ${input.questionId}, ${tx.json(after)},
                ${tx.json((last?.keys ?? finishedKeys(attempt)) as never)},
                ${last?.score ?? attempt.score ?? total(before)}, ${to}, ${to >= attempt.quiz.passMark}, ${comment},
                ${input.reason}, ${input.operatorId}, ${input.now})
      `;
    });
    return this.attempts(input.itemId);
  }

  /** Every finished attempt under its alias, with its points per question and its score trail. Writes nothing. */
  async attempts(itemId: string): Promise<AcademyCourseQuizAttempts> {
    const [quiz] = await this.sql<
      Array<{
        title: string;
        kind: string;
        revision: number | null;
        pass_mark: number | null;
        questions: AcademyCourseQuizQuestion[] | null;
      }>
    >`
      SELECT i.title, i.kind, q.revision, q.pass_mark, q.questions
      FROM academy.course_items i LEFT JOIN academy.course_quizzes q ON q.item_id = i.id
      WHERE i.id = ${itemId}
    `;
    if (!quiz || quiz.kind !== 'quiz') throw new AcademyError('no quiz with that id', 'academy.quiz_not_found');
    const current = questionsOf(quiz);
    const rows = await this.sql<Array<TrailAttempt & { alias: number }>>`
      SELECT ${ATTEMPT(this.sql)}, a.alias FROM academy.course_quiz_attempts t
      JOIN (SELECT user_id, row_number() OVER (ORDER BY min(started_at), user_id)::int AS alias
            FROM academy.course_quiz_attempts WHERE item_id = ${itemId} GROUP BY user_id) a USING (user_id)
      WHERE t.item_id = ${itemId} AND t.state <> 'open'
      ORDER BY a.alias, t.number
    `;
    const events = await this.sql<EventRow[]>`
      SELECT e.* FROM academy.course_quiz_score_events e JOIN academy.course_quiz_attempts t ON t.id = e.attempt_id
      WHERE t.item_id = ${itemId}
      ORDER BY e.attempt_id, e.n
    `;
    const trail = new Map<string, EventRow[]>();
    for (const e of events) (trail.get(e.attempt_id) ?? trail.set(e.attempt_id, []).get(e.attempt_id)!).push(e);
    return {
      itemId,
      title: quiz.title,
      revision: quiz.revision ?? 0,
      passMark: quiz.pass_mark,
      attempts: rows.map((r) => {
        const own = trail.get(r.id) ?? [];
        const last = own.at(-1);
        const graded = r.state === 'graded';
        const points = last?.points ?? (graded ? finishedPoints(r) : null);
        return {
          attemptId: r.id,
          alias: r.alias,
          number: r.number,
          finishedAt: r.finished_at.toISOString(),
          state: r.state,
          originalScore: r.score,
          score: last?.score ?? r.score,
          maxScore: r.max_score ?? 0,
          passed: last?.passed ?? r.passed,
          passMark: r.quiz.passMark,
          rescoreDue: graded && onOlderKeys(r, last?.keys ?? finishedKeys(r), current),
          questions: r.quiz.questions.map((q) => ({
            questionId: q.id,
            prompt: q.prompt,
            points: q.points,
            earned: points ? (points[q.id] ?? 0) : null,
          })),
          events: own.map((e) => ({
            n: e.n,
            kind: e.kind,
            questionId: e.question_id,
            revision: e.revision,
            previousScore: e.previous_score,
            score: e.score,
            passed: e.passed,
            comment: e.comment,
            reason: e.reason,
            at: e.at.toISOString(),
          })),
          nextN: (last?.n ?? 0) + 1,
        };
      }),
    };
  }

  private async lastEvent(tx: Db, attemptId: string): Promise<EventRow | null> {
    const [last] = await tx<EventRow[]>`
      SELECT * FROM academy.course_quiz_score_events WHERE attempt_id = ${attemptId} ORDER BY n DESC LIMIT 1
    `;
    return last ?? null;
  }
}
