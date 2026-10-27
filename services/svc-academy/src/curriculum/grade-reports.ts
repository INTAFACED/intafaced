/**
 * AC-assignments-04, report part — time-stamped grade reports of a course staff made.
 *
 * Making a report stores the gradebook as it reads now (course-gradebook.ts) as a CSV: one row per enrolled learner, each
 * item's score as a decimal fraction or "not attempted" / "pending" (never zero), each type's average and the total. The
 * first line names the report's number and the time it was made, so every report has bytes, and a SHA-256, of its own.
 * A download is that stored snapshot: nothing is worked out again.
 *
 * Reports are numbered per course and staff send the number they read as next (`gradereport:<course>:<n>`): a retry of a
 * request that already made report n answers report n; a number past the next refuses. How many learner rows one report
 * may hold is an owner value (`ACADEMY_GRADE_REPORT_ROWS`): blank refuses `academy.report_limit_unset` and a course with
 * more learners refuses `academy.report_too_large`, before anything is written. No money moves.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { AcademyCourseGradebook, AcademyGradeReport, AcademyGradeReportFile } from '@intafaced/contracts';
import { defineRefusals, requireSetting } from '@intafaced/service-kit';
import type { CourseGradebook } from './course-gradebook.js';

export const gradeReportRefusals = defineRefusals('GradeReportError', {
  'academy.course_not_found': 'NOT_FOUND',
  'academy.report_not_found': 'NOT_FOUND',
  'academy.report_limit_unset': 'PRECONDITION_FAILED',
  'academy.report_too_large': 'PRECONDITION_FAILED',
  'academy.report_out_of_order': 'CONFLICT',
});
const refuse = gradeReportRefusals.refuse;

type Stored = { course_id: string; n: number; csv: string; sha256: string; rows: number; made_by: string; made_at: Date };

const meta = (r: Stored): AcademyGradeReport => ({
  courseId: r.course_id,
  n: r.n,
  madeAt: r.made_at.toISOString(),
  madeBy: r.made_by,
  rows: r.rows,
  sha256: r.sha256,
});

/** One CSV field: quoted when it holds a comma, quote or line break; a leading = + - @ is kept as text, never a formula. */
export function csvField(value: string): string {
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The gradebook as CSV. Scores stay the gradebook's decimal fraction strings; an item with none says why. */
export function gradeReportCsv(book: AcademyCourseGradebook, n: number, madeAt: Date): string {
  const types = book.policy?.types ?? [];
  const line = (cells: string[]) => cells.map(csvField).join(',');
  const lines = [
    line(['grade report', String(n), 'made at', madeAt.toISOString()]),
    line(['learner', ...book.items.map((i) => i.title), ...types.map((t) => `${t.name} (${t.weight})`), 'total']),
    ...book.learners.map((l) =>
      line([
        l.userId,
        ...l.items.map((c) => (c.state === 'graded' ? c.score! : c.state === 'pending' ? 'pending' : 'not attempted')),
        ...l.types.map((t) => t.average ?? 'not attempted'),
        l.total ?? (book.policy ? 'not attempted' : 'no policy'),
      ]),
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export class GradeReports {
  /** `rowLimit` is `ACADEMY_GRADE_REPORT_ROWS` as read from env: null when blank. */
  constructor(
    private readonly sql: Sql,
    private readonly gradebook: Pick<CourseGradebook, 'view'>,
    private readonly rowLimit: number | null,
  ) {}

  /** The course's stored reports, newest first. */
  async list(courseId: string): Promise<{ courseId: string; reports: AcademyGradeReport[] }> {
    await this.course(this.sql, courseId);
    const rows = await this.sql<Stored[]>`
      SELECT course_id, n, '' AS csv, sha256, rows, made_by, made_at FROM academy.course_grade_reports
      WHERE course_id = ${courseId} ORDER BY n DESC
    `;
    return { courseId, reports: rows.map(meta) };
  }

  /** Report n of the course: made now when n is next, the stored one when it already exists. */
  async make(input: { courseId: string; n: number; operatorId: string; now: Date }): Promise<AcademyGradeReport> {
    const limit = requireSetting(this.rowLimit, gradeReportRefusals, 'academy.report_limit_unset');
    return this.sql.begin(async (tx) => {
      // One maker per course at a time, so two requests cannot both take the next number.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`gradereport:${input.courseId}`}))`;
      await this.course(tx, input.courseId);
      const [existing] = await tx<Stored[]>`
        SELECT course_id, n, csv, sha256, rows, made_by, made_at FROM academy.course_grade_reports
        WHERE course_id = ${input.courseId} AND n = ${input.n}
      `;
      if (existing) return meta(existing);
      const [{ next } = { next: 1 }] = await tx<Array<{ next: number }>>`
        SELECT coalesce(max(n), 0)::int + 1 AS next FROM academy.course_grade_reports WHERE course_id = ${input.courseId}
      `;
      if (input.n !== next) refuse('academy.report_out_of_order', `the next report of this course is ${next}, not ${input.n}`);
      const book = await this.gradebook.view(input.courseId);
      if (book.learners.length > limit)
        refuse('academy.report_too_large', `${book.learners.length} learners, over the ${limit} rows one report holds`, {
          limit: String(limit),
        });
      const csv = gradeReportCsv(book, input.n, input.now);
      const sha256 = createHash('sha256').update(csv, 'utf8').digest('hex');
      const [made] = await tx<Stored[]>`
        INSERT INTO academy.course_grade_reports (course_id, n, csv, sha256, rows, made_by, made_at)
        VALUES (${input.courseId}, ${input.n}, ${csv}, ${sha256}, ${book.learners.length}, ${input.operatorId}, ${input.now})
        RETURNING course_id, n, csv, sha256, rows, made_by, made_at
      `;
      return meta(made!);
    });
  }

  /** A stored report with its CSV, exactly as it was made. */
  async file(courseId: string, n: number): Promise<AcademyGradeReportFile> {
    const [found] = await this.sql<Stored[]>`
      SELECT course_id, n, csv, sha256, rows, made_by, made_at FROM academy.course_grade_reports
      WHERE course_id = ${courseId} AND n = ${n}
    `;
    if (!found) return refuse('academy.report_not_found', `course ${courseId} has no report ${n}`);
    return { ...meta(found), csv: found.csv };
  }

  private async course(sql: Sql | TransactionSql, courseId: string): Promise<void> {
    const [course] = await sql`SELECT id FROM academy.courses WHERE id = ${courseId}`;
    if (!course) refuse('academy.course_not_found', 'no course has that id');
  }
}
