/**
 * AC-enrolment-01 step 4 — a course's start date. Staff set or clear it with a reason, and the row keeps who did it and
 * why; no row or a cleared one means the course is self-paced and opens on enrolment. Until then every item in the course is held as a window (`release/access.ts`), and the
 * course page and My learning show the date. Nothing is given a start date it was not set.
 */
import type { Sql } from 'postgres';
import { AcademyError } from '../errors.js';
import type { CurriculumPath } from './catalog.js';
import { publishedCourse } from './course-enrolment.js';

export type CourseStartChoice = { slug: CurriculumPath; startsAt: Date | null; reason: string; setAt: Date };

/** Blank after trim is not a reason, and none is invented. */
function requireStartReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new AcademyError('academy.reason_required', 'academy.reason_required');
  return trimmed;
}

/** The one read of a course's start date, shared by the release gate and the views that show it. */
export async function readCourseStart(sql: Sql, path: string): Promise<Date | null> {
  const rows = await sql<Array<{ starts_at: Date | null }>>`SELECT starts_at FROM academy.course_starts WHERE path = ${path}`;
  return rows[0]?.starts_at ?? null;
}

export class CourseStarts {
  constructor(private readonly sql: Sql) {}

  startsAt(path: CurriculumPath): Promise<Date | null> {
    return readCourseStart(this.sql, path);
  }

  /** `startsAt: null` clears the date and keeps who cleared it and why. A blank reason is refused, never filled in. */
  async set(input: { slug: string; startsAt: Date | null; reason: string; operatorId: string; now?: Date }): Promise<CourseStartChoice> {
    const slug = publishedCourse(input.slug);
    const reason = requireStartReason(input.reason);
    const setAt = input.now ?? new Date();
    await this.sql`
      INSERT INTO academy.course_starts (path, starts_at, reason, set_by, set_at)
      VALUES (${slug}, ${input.startsAt}, ${reason}, ${input.operatorId}, ${setAt})
      ON CONFLICT (path) DO UPDATE SET
        starts_at = EXCLUDED.starts_at,
        reason = EXCLUDED.reason,
        set_by = EXCLUDED.set_by,
        set_at = EXCLUDED.set_at
    `;
    return { slug, startsAt: input.startsAt, reason, setAt };
  }
}
