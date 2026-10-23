/**
 * Assessment attempts. One row per clientAttemptId. A replay returns that
 * row and does not rescore, even when the new answers differ.
 */

import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { AcademyError } from '../errors.js';
import type { AcademyQuizAttempt, AcademyQuizReview, AcademySetQuizInput } from '@intafaced/contracts';
import { assertAssessmentCatalog, AssessmentCatalogError, assessmentBySlug, type AssessmentDefinition } from './catalog.js';
import { scoreAssessment, type AssessmentAnswer } from './score.js';

export type AttemptRow = {
  readonly slug: string;
  readonly score: number;
  readonly maxScore: number;
  readonly pass: boolean;
  readonly submittedAt: Date;
};

type AttemptSql = {
  slug: string;
  score: number;
  max_score: number;
  passed: boolean;
  submitted_at: Date;
};

const mapAttempt = (row: AttemptSql): AttemptRow => ({
  slug: row.slug,
  score: row.score,
  maxScore: row.max_score,
  pass: row.passed,
  submittedAt: row.submitted_at,
});

export class AssessmentRepository {
  constructor(
    private readonly sql: Sql,
    private readonly catalog: readonly AssessmentDefinition[],
  ) {}

  /** The quiz on an item: the code catalog first, then what staff published (AC-quizzes-03). Null: none is published. */
  async definition(slug: string, sql: Sql = this.sql): Promise<AssessmentDefinition | null> {
    const coded = assessmentBySlug(slug, this.catalog);
    if (coded) return coded;
    const rows = await sql<QuizSql[]>`
      SELECT slug, definition, pass_mark, attempt_limit, time_limit_seconds, review_mode FROM academy.quizzes WHERE slug = ${slug}
    `;
    return rows[0] ? quizFromRow(rows[0]) : null;
  }

  /** Every item slug with a published quiz, for one outline read. */
  async publishedSlugs(): Promise<Set<string>> {
    const rows = await this.sql<Array<{ slug: string }>>`SELECT slug FROM academy.quizzes`;
    return new Set([...this.catalog.map((row) => row.slug), ...rows.map((row) => row.slug)]);
  }

  /**
   * Staff publish the quiz on one item, replacing any earlier one, or take it down with `quiz: null`. A slug the code
   * catalog already holds is the owner's and is refused. The definition is checked as the code catalog is.
   */
  async setQuiz(input: AcademySetQuizInput & { operatorId: string; lesson: (slug: string) => boolean; now?: Date }) {
    const slug = input.slug.trim();
    if (!input.lesson(slug)) throw new AcademyError('Unknown curriculum item', 'academy.curriculum_not_found');
    if (assessmentBySlug(slug, this.catalog)) {
      throw new AcademyError(`academy.assessment_invalid ${slug} is published in the code catalog`, 'academy.assessment_invalid');
    }
    if (input.quiz === null) {
      await this.sql`DELETE FROM academy.quizzes WHERE slug = ${slug}`;
      return { slug, published: false };
    }
    const definition: AssessmentDefinition = {
      slug,
      kind: 'quiz',
      passMark: input.quiz.passMark,
      attemptLimit: input.quiz.attemptLimit,
      cooldownSeconds: null,
      timeLimitSeconds: input.quiz.timeLimitSeconds,
      reviewMode: input.quiz.reviewMode,
      questions: input.quiz.questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        kind: 'single' as const,
        points: q.points,
        choices: q.choices.map((c) => ({ id: c.id, text: c.text })),
        correctChoiceId: q.correctChoiceId,
      })),
    };
    try {
      assertAssessmentCatalog([definition], input.lesson);
    } catch (err) {
      if (err instanceof AssessmentCatalogError)
        throw new AcademyError(`academy.assessment_invalid ${err.message}`, 'academy.assessment_invalid');
      throw err;
    }
    const now = input.now ?? new Date();
    await this.sql`
      INSERT INTO academy.quizzes (slug, definition, pass_mark, attempt_limit, time_limit_seconds, review_mode, reason, set_by, set_at)
      VALUES (${slug}, ${this.sql.json(definition.questions as never)}, ${definition.passMark}, ${definition.attemptLimit},
              ${definition.timeLimitSeconds ?? null}, ${definition.reviewMode!}, ${input.reason.trim()}, ${input.operatorId}, ${now})
      ON CONFLICT (slug) DO UPDATE SET
        definition = EXCLUDED.definition, pass_mark = EXCLUDED.pass_mark, attempt_limit = EXCLUDED.attempt_limit,
        time_limit_seconds = EXCLUDED.time_limit_seconds, review_mode = EXCLUDED.review_mode,
        reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
    `;
    return { slug, published: true };
  }

  async attempts(userId: string, slug: string): Promise<AttemptRow[]> {
    if (!(await this.definition(slug))) {
      throw new AcademyError(`academy.assessment_unpublished slug=${slug}`, 'academy.assessment_unpublished');
    }
    const rows = await this.sql<AttemptSql[]>`
      SELECT slug, score, max_score, passed, submitted_at
        FROM academy.assessment_attempts
       WHERE user_id = ${userId} AND slug = ${slug}
       ORDER BY submitted_at DESC, client_attempt_id DESC
    `;
    return rows.map(mapAttempt);
  }

  async submit(input: {
    userId: string;
    slug: string;
    answers: readonly AssessmentAnswer[];
    clientAttemptId: string;
    now?: Date;
  }): Promise<AttemptRow> {
    const clientAttemptId = input.clientAttemptId.trim();
    if (!clientAttemptId) throw new AcademyError('clientAttemptId is required', 'academy.assessment_invalid');
    const now = input.now ?? new Date();
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:assessment`}, 0))`;
      const prior = await tx<AttemptSql[]>`
        SELECT slug, score, max_score, passed, submitted_at
          FROM academy.assessment_attempts
         WHERE user_id = ${input.userId} AND client_attempt_id = ${clientAttemptId}
      `;
      if (prior[0]) return mapAttempt(prior[0]);

      const def = await this.definition(input.slug, tx);
      if (!def) {
        throw new AcademyError(`academy.assessment_unpublished slug=${input.slug}`, 'academy.assessment_unpublished');
      }
      // A staff-published or timed quiz is taken through Start, so its clock and its one open attempt cannot be skipped.
      if (!assessmentBySlug(def.slug, this.catalog) || (def.timeLimitSeconds ?? null) !== null) {
        throw new AcademyError(`academy.attempt_required slug=${def.slug} is taken with Start`, 'academy.attempt_required');
      }
      if (def.passMark === null) {
        throw new AcademyError(`academy.pass_mark_unset slug=${def.slug}`, 'academy.pass_mark_unset');
      }
      const open =
        await tx`SELECT 1 FROM academy.quiz_attempts WHERE user_id = ${input.userId} AND slug = ${def.slug} AND finished_at IS NULL`;
      if (open.length > 0) throw new AcademyError(`academy.attempt_open slug=${def.slug}`, 'academy.attempt_open');
      await this.assertMayAttempt(tx, def, input.userId, now);
      const scored = scoreAssessment(def, input.answers);
      const rows = await tx<AttemptSql[]>`
        INSERT INTO academy.assessment_attempts (
          user_id, slug, client_attempt_id, score, max_score, passed, submitted_at
        ) VALUES (
          ${input.userId}, ${def.slug}, ${clientAttemptId}, ${scored.score}, ${scored.maxScore}, ${scored.pass}, ${now}
        )
        ON CONFLICT (user_id, client_attempt_id) DO NOTHING
        RETURNING slug, score, max_score, passed, submitted_at
      `;
      if (rows[0]) return mapAttempt(rows[0]);
      const raced = await tx<AttemptSql[]>`
        SELECT slug, score, max_score, passed, submitted_at
          FROM academy.assessment_attempts
         WHERE user_id = ${input.userId} AND client_attempt_id = ${clientAttemptId}
      `;
      if (!raced[0]) throw new AcademyError('attempt insert left no row', 'academy.assessment_invalid');
      return mapAttempt(raced[0]);
    });
  }

  async passedSlugs(userId: string): Promise<Set<string>> {
    const rows = await this.sql<Array<{ slug: string }>>`
      SELECT DISTINCT slug FROM academy.assessment_attempts
       WHERE user_id = ${userId} AND passed = true
    `;
    return new Set(rows.map((row) => row.slug));
  }

  /**
   * Start a timed attempt (AC-quizzes-03), or return the one already open: a refresh or a lost reply gets the same
   * attempt, deadline and saved answers. An open attempt past its deadline is finished with what was saved first. At
   * the attempt limit (finished attempts, including ones sent through `submit`) Start refuses `academy.attempt_limit`,
   * and inside a cooldown `academy.attempt_cooldown`. The attempt keeps a copy of the quiz as it was at Start, so a
   * later staff edit or take-down changes neither its scoring nor its review.
   */
  async start(input: { userId: string; slug: string; now?: Date }): Promise<AcademyQuizAttempt> {
    const now = input.now ?? new Date();
    return this.underQuizLock(input.userId, async (tx) => {
      const open = await this.settleOpen(tx, input.userId, input.slug, now);
      if (open) return attemptView(open, now);
      const def = await this.definition(input.slug, tx);
      if (!def) throw new AcademyError(`academy.assessment_unpublished slug=${input.slug}`, 'academy.assessment_unpublished');
      if (def.passMark === null) throw new AcademyError(`academy.pass_mark_unset slug=${def.slug}`, 'academy.pass_mark_unset');
      const count = await this.assertMayAttempt(tx, def, input.userId, now);
      const limit = def.timeLimitSeconds ?? null;
      const deadline = limit === null ? null : new Date(now.getTime() + limit * 1000);
      const rows = await tx<AttemptRowSql[]>`
        INSERT INTO academy.quiz_attempts (user_id, slug, number, started_at, deadline_at, quiz)
        VALUES (${input.userId}, ${def.slug}, ${count + 1}, ${now}, ${deadline}, ${tx.json(def as never)})
        RETURNING ${tx.unsafe(ATTEMPT_COLUMNS)}
      `;
      return attemptView(rows[0]!, now);
    });
  }

  /**
   * The caller's open attempt on this quiz, or null. One past its deadline is finished here and is not open: its score
   * was fixed at the deadline by what was saved, so settling it on a read records an outcome, it does not choose one.
   */
  async current(input: { userId: string; slug: string; now?: Date }): Promise<AcademyQuizAttempt | null> {
    const now = input.now ?? new Date();
    return this.underQuizLock(input.userId, async (tx) => {
      const open = await this.settleOpen(tx, input.userId, input.slug, now);
      return open ? attemptView(open, now) : null;
    });
  }

  /** Save one answer on the caller's open attempt. A finished attempt, or one past its deadline, refuses `academy.attempt_closed`. */
  async answer(input: {
    userId: string;
    attemptId: string;
    questionId: string;
    choiceId: string;
    now?: Date;
  }): Promise<AcademyQuizAttempt> {
    const now = input.now ?? new Date();
    const slug = await this.attemptSlug(input.userId, input.attemptId);
    return this.underQuizLock(input.userId, async (tx) => {
      const open = await this.settleOpen(tx, input.userId, slug, now);
      if (!open || open.id !== input.attemptId) {
        throw new AcademyError('academy.attempt_closed this attempt is finished', 'academy.attempt_closed');
      }
      const question = open.quiz.questions.find((q) => q.id === input.questionId);
      if (!question || !question.choices.some((c) => c.id === input.choiceId)) {
        throw new AcademyError('answer does not match a published question', 'academy.assessment_invalid');
      }
      const rows = await tx<AttemptRowSql[]>`
        UPDATE academy.quiz_attempts SET answers = answers || ${tx.json({ [input.questionId]: input.choiceId })}
         WHERE id = ${open.id}
        RETURNING ${tx.unsafe(ATTEMPT_COLUMNS)}
      `;
      return attemptView(rows[0]!, now);
    });
  }

  /** Finish and score the saved answers once. Finishing again answers with the same result; nothing is scored twice. */
  async finish(input: { userId: string; attemptId: string; now?: Date }): Promise<AcademyQuizAttempt> {
    const now = input.now ?? new Date();
    await this.attemptSlug(input.userId, input.attemptId);
    return this.underQuizLock(input.userId, async (tx) => {
      const rows = await tx<AttemptRowSql[]>`
        SELECT ${tx.unsafe(ATTEMPT_COLUMNS)} FROM academy.quiz_attempts WHERE id = ${input.attemptId} AND user_id = ${input.userId}
      `;
      const row = rows[0]!;
      if (row.finished_at) return attemptView(row, now);
      return attemptView(await this.finishRow(tx, row, now), now);
    });
  }

  /** A finished attempt of the caller's own: each answer against the key, or the score only when the quiz hides answers. */
  async review(input: { userId: string; attemptId: string }): Promise<AcademyQuizReview> {
    const rows = await this.sql<AttemptRowSql[]>`
      SELECT ${this.sql.unsafe(ATTEMPT_COLUMNS)} FROM academy.quiz_attempts WHERE id = ${input.attemptId} AND user_id = ${input.userId}
    `;
    const row = rows[0];
    if (!row) throw new AcademyError('academy.attempt_not_found', 'academy.attempt_not_found');
    if (!row.finished_at) throw new AcademyError('academy.attempt_open finish the attempt to review it', 'academy.attempt_open');
    // Reviewed against the quiz as it was at Start, the same version it was scored against.
    const def = row.quiz;
    const mode = def.reviewMode ?? 'score_only';
    return {
      attemptId: row.id,
      slug: row.slug,
      number: row.number,
      score: row.score!,
      maxScore: row.max_score!,
      pass: row.passed!,
      finishedAt: row.finished_at.toISOString(),
      reviewMode: mode,
      questions:
        mode === 'score_only'
          ? null
          : def.questions.map((q) => {
              const chosen = row.answers[q.id] ?? null;
              return {
                id: q.id,
                prompt: q.prompt,
                choices: q.choices.map((c) => ({ id: c.id, text: c.text })),
                chosenChoiceId: chosen,
                correctChoiceId: q.correctChoiceId,
                correct: chosen === q.correctChoiceId,
              };
            }),
    };
  }

  /** The caller's attempt's quiz. Another learner's attempt id is not found, the same as one that does not exist. */
  private async attemptSlug(userId: string, attemptId: string): Promise<string> {
    const rows = await this.sql<Array<{ slug: string }>>`
      SELECT slug FROM academy.quiz_attempts WHERE id = ${attemptId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new AcademyError('academy.attempt_not_found', 'academy.attempt_not_found');
    return rows[0].slug;
  }

  private async underQuizLock<T>(userId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return transaction(this.sql, async (tx) => {
      // The same key `submit` takes, so a timed attempt and a direct submit never count the limit apart.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:assessment`}, 0))`;
      return fn(tx);
    });
  }

  /**
   * The attempt limit and the cooldown, for `submit` and Start alike. Counts finished attempts (timed ones write their
   * score row when they finish) and returns that count.
   */
  private async assertMayAttempt(tx: Sql, def: AssessmentDefinition, userId: string, now: Date): Promise<number> {
    const rows = await tx<Array<{ n: number; last: Date | null }>>`
      SELECT COUNT(*)::int AS n, MAX(submitted_at) AS last FROM academy.assessment_attempts
       WHERE user_id = ${userId} AND slug = ${def.slug}
    `;
    const count = rows[0]?.n ?? 0;
    if (def.attemptLimit !== null && count >= def.attemptLimit) {
      throw new AcademyError(`academy.attempt_limit slug=${def.slug} limit=${def.attemptLimit}`, 'academy.attempt_limit');
    }
    const last = rows[0]?.last ?? null;
    if (def.cooldownSeconds !== null && last && now.getTime() - last.getTime() < def.cooldownSeconds * 1000) {
      throw new AcademyError(`academy.attempt_cooldown slug=${def.slug}`, 'academy.attempt_cooldown');
    }
    return count;
  }

  /** The open attempt, unless its deadline has passed: then it is finished with the answers saved by the deadline. */
  private async settleOpen(tx: Sql, userId: string, slug: string, now: Date): Promise<AttemptRowSql | null> {
    const rows = await tx<AttemptRowSql[]>`
      SELECT ${tx.unsafe(ATTEMPT_COLUMNS)} FROM academy.quiz_attempts
       WHERE user_id = ${userId} AND slug = ${slug} AND finished_at IS NULL
    `;
    const open = rows[0];
    if (!open) return null;
    if (open.deadline_at && now.getTime() >= open.deadline_at.getTime()) {
      await this.finishRow(tx, open, open.deadline_at);
      return null;
    }
    return open;
  }

  /** Score the saved answers against the attempt's own copy of the quiz, and write its score row once. */
  private async finishRow(tx: Sql, row: AttemptRowSql, at: Date): Promise<AttemptRowSql> {
    const def = row.quiz;
    const answers = Object.entries(row.answers)
      .filter(([questionId, choiceId]) => def.questions.some((q) => q.id === questionId && q.choices.some((c) => c.id === choiceId)))
      .map(([questionId, choiceId]) => ({ questionId, choiceId }));
    const scored = scoreAssessment(def, answers);
    const finishedAt = row.deadline_at && at.getTime() > row.deadline_at.getTime() ? row.deadline_at : at;
    const rows = await tx<AttemptRowSql[]>`
      UPDATE academy.quiz_attempts SET finished_at = ${finishedAt}, score = ${scored.score}, max_score = ${scored.maxScore}, passed = ${scored.pass}
       WHERE id = ${row.id}
      RETURNING ${tx.unsafe(ATTEMPT_COLUMNS)}
    `;
    await tx`
      INSERT INTO academy.assessment_attempts (user_id, slug, client_attempt_id, score, max_score, passed, submitted_at)
      VALUES (${row.user_id}, ${row.slug}, ${`quiz-attempt:${row.id}`}, ${scored.score}, ${scored.maxScore}, ${scored.pass}, ${finishedAt})
      ON CONFLICT (user_id, client_attempt_id) DO NOTHING
    `;
    return rows[0]!;
  }
}

type QuizSql = {
  slug: string;
  definition: AssessmentDefinition['questions'];
  pass_mark: number | null;
  attempt_limit: number | null;
  time_limit_seconds: number | null;
  review_mode: 'answers' | 'score_only';
};

function quizFromRow(row: QuizSql): AssessmentDefinition {
  return {
    slug: row.slug,
    kind: 'quiz',
    questions: row.definition,
    passMark: row.pass_mark,
    attemptLimit: row.attempt_limit,
    cooldownSeconds: null,
    timeLimitSeconds: row.time_limit_seconds,
    reviewMode: row.review_mode,
  };
}

const ATTEMPT_COLUMNS = 'id, user_id, slug, number, started_at, deadline_at, answers, finished_at, score, max_score, passed, quiz';
type AttemptRowSql = {
  id: string;
  user_id: string;
  slug: string;
  number: number;
  started_at: Date;
  deadline_at: Date | null;
  answers: Record<string, string>;
  finished_at: Date | null;
  score: number | null;
  max_score: number | null;
  passed: boolean | null;
  /** The quiz as it was at Start, answer key included; it never leaves the service. */
  quiz: AssessmentDefinition;
};

function attemptView(row: AttemptRowSql, now: Date): AcademyQuizAttempt {
  const open = row.finished_at === null;
  return {
    attemptId: row.id,
    slug: row.slug,
    number: row.number,
    startedAt: row.started_at.toISOString(),
    deadlineAt: row.deadline_at?.toISOString() ?? null,
    secondsLeft: open && row.deadline_at ? Math.max(0, Math.ceil((row.deadline_at.getTime() - now.getTime()) / 1000)) : null,
    answers: { ...row.answers },
    result: open ? null : { score: row.score!, maxScore: row.max_score!, pass: row.passed!, finishedAt: row.finished_at!.toISOString() },
  };
}
