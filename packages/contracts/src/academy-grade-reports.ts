import { z } from 'zod';

/**
 * AC-assignments-04, report part: a time-stamped grade report of a course staff made.
 *
 * Making a report stores a snapshot of the gradebook as it reads at that moment: a CSV with one row per enrolled learner,
 * every score as a decimal fraction string (0.65 is 65 percent), "not attempted" where there is no score (never zero),
 * the time it was made and the SHA-256 of its bytes. Downloading a report serves that stored snapshot, never a fresh
 * one, so two downloads can be compared. Reports are numbered per course: staff send the number they expect next, so a
 * retried request answers the report it made the first time (`gradereport:<course>:<n>`). No money moves here.
 */
const isoInstant = z.string().datetime({ offset: true });

export const academyGradeReportSchema = z.object({
  courseId: z.string().guid(),
  n: z.number().int().positive(),
  madeAt: isoInstant,
  madeBy: z.string().guid(),
  rows: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AcademyGradeReport = z.infer<typeof academyGradeReportSchema>;

/** `admin.courseGradeReports`: the course's stored reports, newest first. */
export const academyGradeReportsSchema = z.object({ courseId: z.string().guid(), reports: z.array(academyGradeReportSchema) });
export type AcademyGradeReports = z.infer<typeof academyGradeReportsSchema>;

/** `admin.makeGradeReport`: `n` is the number the desk read as next (the count of stored reports plus one). */
export const academyMakeGradeReportInputSchema = z.object({ courseId: z.string().guid(), n: z.number().int().positive() }).strict();
export type AcademyMakeGradeReportInput = z.infer<typeof academyMakeGradeReportInputSchema>;

/** `admin.gradeReportFile`: one stored report with its CSV. */
export const academyGradeReportFileInputSchema = academyMakeGradeReportInputSchema;
export const academyGradeReportFileSchema = academyGradeReportSchema.extend({ csv: z.string() });
export type AcademyGradeReportFile = z.infer<typeof academyGradeReportFileSchema>;
