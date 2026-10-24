/**
 * AC-programmes-01 — learning programmes staff make: an ordered set of published courses with a title and a summary.
 *
 * Each save is a revision with an event row naming the operator and the reason; a save that matches the stored programme
 * answers it unchanged, so a replay after a lost reply writes nothing. How many courses one programme may hold is an owner
 * value with no default (`ACADEMY_PROGRAMME_MAX_COURSES`): a save with courses while it is blank refuses
 * `academy.programme_limit_unset`. This module stores programmes and decides nothing about a learner; AcademyService
 * counts courses and issues the programme certificate. No money moves here.
 */
import type { Sql, TransactionSql } from 'postgres';
import { ACADEMY_PROGRAMME_RESERVED_SLUGS, type AcademyProgrammeRecord, type AcademySaveProgrammeInput } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import { AcademyError } from '../errors.js';
import type { CurriculumPath } from './catalog.js';

type Db = Sql | TransactionSql;

type ProgrammeRow = {
  slug: string;
  title: string;
  summary: string;
  revision: number;
  updated_at: Date;
  course_slugs: string[] | null;
};

const recordOf = (row: ProgrammeRow): AcademyProgrammeRecord => ({
  slug: row.slug,
  title: row.title,
  summary: row.summary,
  courseSlugs: (row.course_slugs ?? []) as CurriculumPath[],
  revision: row.revision,
  updatedAt: row.updated_at,
});

/** Pure: refuses a save the owner's limit or the address rules do not allow. */
export function assertProgrammeSave(
  input: Pick<AcademySaveProgrammeInput, 'slug' | 'courseSlugs'>,
  maxCourses: number | undefined,
  isPublished: (course: string) => boolean,
): void {
  if ((ACADEMY_PROGRAMME_RESERVED_SLUGS as readonly string[]).includes(input.slug)) {
    throw new AcademyError(`slug "${input.slug}" is a reserved academy address`, 'academy.slug_reserved');
  }
  for (const course of input.courseSlugs) {
    if (!isPublished(course)) throw new AcademyError(`academy.path_not_found course=${course}`, 'academy.path_not_found');
  }
  if (input.courseSlugs.length === 0) return;
  if (maxCourses === undefined) throw new AcademyError('academy.programme_limit_unset', 'academy.programme_limit_unset');
  if (input.courseSlugs.length > maxCourses) {
    throw new AcademyError(`academy.programme_too_large max=${maxCourses}`, 'academy.programme_too_large');
  }
}

const sameCourses = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((slug, i) => slug === b[i]);

export class ProgrammeRecords {
  constructor(
    private readonly sql: Sql,
    private readonly maxCourses: number | undefined,
  ) {}

  private select(db: Db, where: { slug?: string; course?: string; limit?: number }) {
    return db<ProgrammeRow[]>`
      SELECT p.slug, p.title, p.summary, p.revision, p.updated_at,
             (SELECT array_agg(c.course_slug ORDER BY c.position) FROM academy.programme_courses c WHERE c.programme_slug = p.slug)
               AS course_slugs
        FROM academy.programmes p
       WHERE ${where.slug === undefined ? db`TRUE` : db`p.slug = ${where.slug}`}
         AND ${
           where.course === undefined
             ? db`TRUE`
             : db`EXISTS (SELECT 1 FROM academy.programme_courses c WHERE c.programme_slug = p.slug AND c.course_slug = ${where.course})`
         }
       ORDER BY p.created_at DESC, p.slug
       ${where.limit === undefined ? db`LIMIT ALL` : db`LIMIT ${where.limit}`}
    `;
  }

  /** One programme, or null when there is none at that address. */
  async get(slug: string, db: Db = this.sql): Promise<AcademyProgrammeRecord | null> {
    const rows = await this.select(db, { slug });
    return rows[0] ? recordOf(rows[0]) : null;
  }

  /** Programmes newest first, up to the caller's limit. */
  async list(limit: number): Promise<AcademyProgrammeRecord[]> {
    return (await this.select(this.sql, { limit })).map(recordOf);
  }

  /** Every programme that holds this course: the ones a completion in it may finish. */
  async holding(course: string): Promise<AcademyProgrammeRecord[]> {
    return (await this.select(this.sql, { course })).map(recordOf);
  }

  /**
   * Creates a programme (`expectedRevision: null`) or replaces its details and course list over the revision staff read,
   * with its event row, in one transaction. A stale revision refuses `academy.revision_stale`; a create at a taken address
   * refuses `academy.programme_slug_taken`, unless it repeats the stored programme exactly.
   */
  async save(
    input: AcademySaveProgrammeInput & { operatorId: string; now: Date },
    isPublished: (course: string) => boolean,
  ): Promise<AcademyProgrammeRecord> {
    assertProgrammeSave(input, this.maxCourses, isPublished);
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`programme:${input.slug}`}, 0))`;
      const current = await this.get(input.slug, tx);
      const unchanged =
        current !== null &&
        current.title === input.title &&
        current.summary === input.summary &&
        sameCourses(current.courseSlugs, input.courseSlugs);
      if (current && unchanged && (input.expectedRevision === null || input.expectedRevision === current.revision)) return current;
      if (input.expectedRevision === null && current) {
        throw new AcademyError(`academy.programme_slug_taken slug=${input.slug}`, 'academy.programme_slug_taken');
      }
      if (input.expectedRevision !== null && current?.revision !== input.expectedRevision) {
        if (!current) throw new AcademyError(`academy.programme_not_found slug=${input.slug}`, 'academy.programme_not_found');
        throw new AcademyError(`academy.revision_stale revision=${current.revision}`, 'academy.revision_stale');
      }
      const revision = (current?.revision ?? 0) + 1;
      await tx`
        INSERT INTO academy.programmes (slug, title, summary, revision, created_by, created_at, updated_at)
        VALUES (${input.slug}, ${input.title}, ${input.summary}, ${revision}, ${input.operatorId}, ${input.now}, ${input.now})
        ON CONFLICT (slug) DO UPDATE SET
          title = EXCLUDED.title, summary = EXCLUDED.summary, revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at
      `;
      await tx`DELETE FROM academy.programme_courses WHERE programme_slug = ${input.slug}`;
      for (const [position, course] of input.courseSlugs.entries()) {
        await tx`
          INSERT INTO academy.programme_courses (programme_slug, position, course_slug)
          VALUES (${input.slug}, ${position}, ${course})
        `;
      }
      await tx`
        INSERT INTO academy.programme_events (programme_slug, revision, course_slugs, operator_id, reason, recorded_at)
        VALUES (${input.slug}, ${revision}, ${tx.array([...input.courseSlugs])}::text[], ${input.operatorId}, ${input.reason}, ${input.now})
      `;
      return (await this.get(input.slug, tx))!;
    });
  }
}
