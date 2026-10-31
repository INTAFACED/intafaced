/**
 * AC-quizzes-04 — quiz analytics, worked out from real graded attempts as their score trail leaves them.
 *
 * Item analysis per question (how many graded attempts hold it, the share that earned its full points, which is its
 * difficulty as the share who got it right, the mean points, and the same share on first attempts only) and the score
 * distribution (graded attempts at each total). With no graded attempt nothing is counted and the distribution is
 * empty: no figure is invented. Answers learner by learner are answer-level data: they need the data researcher role of
 * AC-roles-01, which has no store here, so every caller is refused `academy.permission_denied`. Writes
 * nothing. No money moves.
 */
import type { Sql } from 'postgres';
import type {
  AcademyCourseQuizAnalytics,
  AcademyCourseQuizAnswer,
  AcademyCourseQuizAnswers,
  AcademyCourseQuizQuestion,
} from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { questionsOf } from './course-quizzes.js';
import { finishedPoints, newestEvents } from './course-quiz-trail.js';

type Graded = {
  id: string;
  user_id: string;
  number: number;
  quiz: { questions: AcademyCourseQuizQuestion[]; passMark: number };
  answers: Record<string, AcademyCourseQuizAnswer>;
  essay_points: Record<string, number> | null;
  score: number | null;
  max_score: number | null;
};

/** part / whole as a percentage with one decimal place, rounded half up; null when whole is 0. Pure. */
export function shareText(part: number, whole: number): string | null {
  if (whole === 0) return null;
  const tenths = Math.floor((part * 2000 + whole) / (2 * whole));
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** sum / n with two decimal places, rounded half up; null when n is 0. Points are whole numbers. Pure. */
export function meanText(sum: number, n: number): string | null {
  if (n === 0) return null;
  const hundredths = Math.floor((sum * 200 + n) / (2 * n));
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;
}

export class CourseQuizAnalytics {
  constructor(private readonly sql: Sql) {}

  async analytics(itemId: string): Promise<AcademyCourseQuizAnalytics> {
    const [quiz] = await this.sql<
      Array<{
        title: string;
        kind: string;
        quiz_kind: string | null;
        revision: number | null;
        questions: AcademyCourseQuizQuestion[] | null;
      }>
    >`
      SELECT i.title, i.kind, q.kind AS quiz_kind, q.revision, q.questions
      FROM academy.course_items i LEFT JOIN academy.course_quizzes q ON q.item_id = i.id
      WHERE i.id = ${itemId}
    `;
    if (!quiz || quiz.kind !== 'quiz' || (quiz.quiz_kind ?? 'quiz') !== 'quiz')
      throw new AcademyError('no graded quiz with that id', 'academy.quiz_not_found');
    const graded = await this.sql<Graded[]>`
      SELECT t.id, t.user_id, t.number, t.quiz, t.answers, t.essay_points, t.score, t.max_score
      FROM academy.course_quiz_attempts t
      WHERE t.item_id = ${itemId} AND t.state = 'graded'
      ORDER BY t.user_id, t.number
    `;
    const events = await newestEvents(
      this.sql,
      graded.map((g) => g.id),
    );
    // A learner's first attempt is their first finished one, graded or still waiting for an essay score: a retake after
    // a pending first attempt is never counted as a first try.
    const firsts = await this.sql<Array<{ user_id: string; number: number }>>`
      SELECT user_id, min(number)::int AS number FROM academy.course_quiz_attempts
      WHERE item_id = ${itemId} AND state <> 'open' GROUP BY user_id
    `;
    const firstOf = new Map(firsts.map((f) => [f.user_id, f.number]));
    const learners = new Set(graded.map((g) => g.user_id)).size;

    const scored = graded.map((g) => {
      const last = events.get(g.id);
      return {
        attempt: g,
        first: firstOf.get(g.user_id) === g.number,
        points: last?.points ?? finishedPoints(g),
        score: last?.score ?? g.score ?? 0,
      };
    });

    const highest = Math.max(0, ...graded.map((g) => g.max_score ?? 0), ...scored.map((s) => s.score));
    const counts = new Map<number, number>();
    for (const s of scored) counts.set(s.score, (counts.get(s.score) ?? 0) + 1);
    const scoreDistribution =
      scored.length === 0 ? [] : Array.from({ length: highest + 1 }, (_, score) => ({ score, count: counts.get(score) ?? 0 }));

    const items = questionsOf(quiz).map((q) => {
      let attempts = 0;
      let full = 0;
      let sum = 0;
      let firstAttempts = 0;
      let firstFull = 0;
      for (const s of scored) {
        const own = s.attempt.quiz.questions.find((x) => x.id === q.id);
        if (!own) continue;
        const earned = s.points[q.id] ?? 0;
        attempts += 1;
        sum += earned;
        if (earned >= own.points) full += 1;
        if (s.first) {
          firstAttempts += 1;
          if (earned >= own.points) firstFull += 1;
        }
      }
      return {
        questionId: q.id,
        prompt: q.prompt,
        kind: q.kind,
        points: q.points,
        attempts,
        fullMarksShare: shareText(full, attempts),
        meanPoints: meanText(sum, attempts),
        firstAttemptFullMarksShare: shareText(firstFull, firstAttempts),
      };
    });

    return {
      itemId,
      title: quiz.title,
      revision: quiz.revision ?? 0,
      graded: graded.length,
      learners,
      scoreDistribution,
      items,
    };
  }

  /**
   * Answers learner by learner, under anonymised ids, for a holder of the data researcher role on the quiz's course.
   * Course roles (AC-roles-01) have no store in this service, so no account holds the role and every caller is refused.
   */
  async answers(input: { itemId: string; operatorId: string }): Promise<AcademyCourseQuizAnswers> {
    const [quiz] = await this.sql<Array<{ kind: string }>>`SELECT kind FROM academy.course_items WHERE id = ${input.itemId}`;
    if (!quiz || quiz.kind !== 'quiz') throw new AcademyError('no graded quiz with that id', 'academy.quiz_not_found');
    throw new AcademyError(
      'answer-level data needs the data researcher role on this course; course roles (AC-roles-01) have no store, so no account holds it',
      'academy.permission_denied',
    );
  }
}
