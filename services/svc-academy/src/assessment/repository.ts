/**
 * Assessment attempts. One row per clientAttemptId. A replay returns that
 * row and does not rescore, even when the new answers differ.
 */

import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { AcademyError } from '../errors.js';
import { assessmentBySlug, type AssessmentDefinition } from './catalog.js';
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

  definition(slug: string): AssessmentDefinition | null {
    return assessmentBySlug(slug, this.catalog);
  }

  async attempts(userId: string, slug: string): Promise<AttemptRow[]> {
    if (!this.definition(slug)) {
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

      const def = this.definition(input.slug);
      if (!def) {
        throw new AcademyError(`academy.assessment_unpublished slug=${input.slug}`, 'academy.assessment_unpublished');
      }
      if (def.passMark === null) {
        throw new AcademyError(`academy.pass_mark_unset slug=${def.slug}`, 'academy.pass_mark_unset');
      }
      if (def.attemptLimit !== null) {
        const count = await tx<Array<{ n: number }>>`
          SELECT COUNT(*)::int AS n FROM academy.assessment_attempts
           WHERE user_id = ${input.userId} AND slug = ${def.slug}
        `;
        if ((count[0]?.n ?? 0) >= def.attemptLimit) {
          throw new AcademyError(`academy.attempt_limit slug=${def.slug}`, 'academy.attempt_limit');
        }
      }
      if (def.cooldownSeconds !== null) {
        const last = await tx<Array<{ submitted_at: Date }>>`
          SELECT submitted_at FROM academy.assessment_attempts
           WHERE user_id = ${input.userId} AND slug = ${def.slug}
           ORDER BY submitted_at DESC
           LIMIT 1
        `;
        const at = last[0]?.submitted_at;
        if (at && now.getTime() - at.getTime() < def.cooldownSeconds * 1000) {
          throw new AcademyError(`academy.attempt_cooldown slug=${def.slug}`, 'academy.attempt_cooldown');
        }
      }
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
}
