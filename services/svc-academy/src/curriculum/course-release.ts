/**
 * AC-release-access-01 — scheduled release and pacing on a course staff made.
 *
 * A section opens at an instant (stored in UTC; each reader's screen shows it in their own time) or a number of whole
 * days after the learner's enrolment. Availability is worked out on each read from the stored rule and the learner's
 * open enrolment, with no timer or job per learner. Until a section opens its items are refused to the learner
 * (`academy.not_released_yet`, naming the instant). A course is self-paced or instructor-paced; once any learner has
 * enrolled the pacing stays (`academy.pacing_locked`). Every change is an event row with who and why. Suggested dates and
 * a minimum lead time before a release are later parts. No money moves here.
 */
import type { Sql, TransactionSql } from 'postgres';
import type {
  AcademyCoursePacing,
  AcademyCourseRelease,
  AcademySectionReleaseRule,
  AcademySetCoursePacingInput,
  AcademySetSectionReleaseInput,
} from '@intafaced/contracts';
import { AcademyError } from '../errors.js';

type Db = Sql | TransactionSql;
const DAY_MS = 86_400_000;

/** The stored rule as the contract's. Null is no rule. Pure. */
export function ruleOf(row: { release_at: Date | null; after_days: number | null }): AcademySectionReleaseRule | null {
  if (row.release_at !== null) return { kind: 'at', at: row.release_at.toISOString() };
  if (row.after_days !== null) return { kind: 'after_enrolment', days: row.after_days };
  return null;
}

/**
 * The instant a section opens for a learner: the rule's instant, or their enrolment plus the days. Null when the rule is
 * relative and there is no enrolment to count from. Pure.
 */
export function opensAt(rule: AcademySectionReleaseRule, enrolledAt: Date | null): Date | null {
  if (rule.kind === 'at') return new Date(rule.at);
  return enrolledAt === null ? null : new Date(enrolledAt.getTime() + rule.days * DAY_MS);
}

/** Refuses `academy.not_released_yet` while the item's section has not opened for this learner. Writes nothing. */
export async function assertItemReleased(sql: Db, itemId: string, userId: string, now: Date): Promise<void> {
  const [row] = await sql<Array<{ release_at: Date | null; after_days: number | null; enrolled_at: Date | null }>>`
    SELECT r.release_at, r.after_days,
      (SELECT e.enrolled_at FROM academy.course_enrolments e
        WHERE e.course_id = i.course_id AND e.user_id = ${userId} AND e.left_at IS NULL) AS enrolled_at
    FROM academy.course_items i JOIN academy.course_section_releases r ON r.section_id = i.section_id
    WHERE i.id = ${itemId}
  `;
  const rule = row ? ruleOf(row) : null;
  if (rule === null) return;
  const at = opensAt(rule, row!.enrolled_at);
  if (at === null || at.getTime() > now.getTime())
    throw new AcademyError(`academy.not_released_yet opens=${at?.toISOString() ?? 'after enrolment'}`, 'academy.not_released_yet');
}

export class CourseRelease {
  constructor(private readonly sql: Sql) {}

  /** The course's pacing and each section's rule, in outline order. */
  async adminView(courseId: string): Promise<AcademyCourseRelease> {
    return this.viewIn(this.sql, courseId);
  }

  /** A section's rule, or none; a repeat of the stored rule answers as stored and writes nothing. */
  async setSectionRelease(input: AcademySetSectionReleaseInput & { operatorId: string; now: Date }): Promise<AcademyCourseRelease> {
    return this.sql.begin(async (tx) => {
      await this.lockCourse(tx, input.courseId);
      const [section] = await tx<Array<{ release_at: Date | null; after_days: number | null }>>`
        SELECT r.release_at, r.after_days FROM academy.course_sections s
        LEFT JOIN academy.course_section_releases r ON r.section_id = s.id
        WHERE s.id = ${input.sectionId} AND s.course_id = ${input.courseId}
      `;
      if (!section) throw new AcademyError('no section of this course has that id', 'academy.outline_item_unknown');
      const stored = ruleOf(section);
      if (JSON.stringify(stored) === JSON.stringify(input.rule === null ? null : normal(input.rule))) return this.viewIn(tx, input.courseId);
      if (input.rule === null) {
        await tx`DELETE FROM academy.course_section_releases WHERE section_id = ${input.sectionId}`;
      } else {
        const at = input.rule.kind === 'at' ? new Date(input.rule.at) : null;
        const days = input.rule.kind === 'after_enrolment' ? input.rule.days : null;
        await tx`
          INSERT INTO academy.course_section_releases (section_id, release_at, after_days, reason, set_by, set_at)
          VALUES (${input.sectionId}, ${at}, ${days}, ${input.reason}, ${input.operatorId}, ${input.now})
          ON CONFLICT (section_id) DO UPDATE SET release_at = EXCLUDED.release_at, after_days = EXCLUDED.after_days,
            reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
        `;
      }
      await tx`
        INSERT INTO academy.course_release_events (course_id, section_id, kind, rule, reason, actor_id, at)
        VALUES (${input.courseId}, ${input.sectionId}, 'section_release',
                ${input.rule === null ? null : tx.json(normal(input.rule) as never)}, ${input.reason}, ${input.operatorId}, ${input.now})
      `;
      return this.viewIn(tx, input.courseId);
    });
  }

  /** Self-paced or instructor-paced, while no learner has enrolled; the same pacing again answers as stored. */
  async setPacing(input: AcademySetCoursePacingInput & { operatorId: string; now: Date }): Promise<AcademyCourseRelease> {
    return this.sql.begin(async (tx) => {
      await this.lockCourse(tx, input.courseId);
      const [current] = await tx<Array<{ pacing: AcademyCoursePacing }>>`
        SELECT pacing FROM academy.course_pacing WHERE course_id = ${input.courseId}
      `;
      if (current?.pacing === input.pacing) return this.viewIn(tx, input.courseId);
      if (await this.started(tx, input.courseId))
        throw new AcademyError('learners have enrolled, so the pacing stays as it is', 'academy.pacing_locked');
      await tx`
        INSERT INTO academy.course_pacing (course_id, pacing, set_by, set_at)
        VALUES (${input.courseId}, ${input.pacing}, ${input.operatorId}, ${input.now})
        ON CONFLICT (course_id) DO UPDATE SET pacing = EXCLUDED.pacing, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
      `;
      await tx`
        INSERT INTO academy.course_release_events (course_id, section_id, kind, rule, reason, actor_id, at)
        VALUES (${input.courseId}, null, 'pacing', ${tx.json({ pacing: input.pacing })}, ${input.reason}, ${input.operatorId}, ${input.now})
      `;
      return this.viewIn(tx, input.courseId);
    });
  }

  /** A course has started once any learner has enrolled, whether or not they are still enrolled. */
  private async started(sql: Db, courseId: string): Promise<boolean> {
    const [row] = await sql<Array<{ started: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM academy.course_enrolments WHERE course_id = ${courseId}) AS started
    `;
    return row!.started;
  }

  private async lockCourse(tx: Db, courseId: string) {
    const [course] = await tx`SELECT id FROM academy.courses WHERE id = ${courseId} FOR UPDATE`;
    if (!course) throw new AcademyError('no course has that id', 'academy.course_not_found');
  }

  private async viewIn(sql: Db, courseId: string): Promise<AcademyCourseRelease> {
    const [course] = await sql<Array<{ pacing: AcademyCoursePacing | null; set_by: string | null; set_at: Date | null }>>`
      SELECT p.pacing, p.set_by, p.set_at FROM academy.courses c LEFT JOIN academy.course_pacing p ON p.course_id = c.id
      WHERE c.id = ${courseId}
    `;
    if (!course) throw new AcademyError('no course has that id', 'academy.course_not_found');
    const sections = await sql<
      Array<{
        id: string;
        title: string;
        release_at: Date | null;
        after_days: number | null;
        reason: string | null;
        set_by: string | null;
        set_at: Date | null;
      }>
    >`
      SELECT s.id, s.title, r.release_at, r.after_days, r.reason, r.set_by, r.set_at
      FROM academy.course_sections s LEFT JOIN academy.course_section_releases r ON r.section_id = s.id
      WHERE s.course_id = ${courseId} ORDER BY s.position
    `;
    return {
      courseId,
      pacing: course.pacing,
      pacingLocked: await this.started(sql, courseId),
      pacingSetBy: course.set_by,
      pacingSetAt: course.set_at?.toISOString() ?? null,
      sections: sections.map((s) => ({
        sectionId: s.id,
        title: s.title,
        rule: ruleOf(s),
        setBy: s.set_by,
        setAt: s.set_at?.toISOString() ?? null,
        reason: s.reason,
      })),
    };
  }
}

/** A rule as stored and read back: an instant in canonical ISO form. */
const normal = (rule: AcademySectionReleaseRule): AcademySectionReleaseRule =>
  rule.kind === 'at' ? { kind: 'at', at: new Date(rule.at).toISOString() } : rule;
