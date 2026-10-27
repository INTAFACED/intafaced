import type { AcademyCourseGradebook } from '@intafaced/contracts/academy-course-gradebook';
import type { AcademyGradeReport, AcademyGradeReports } from '@intafaced/contracts/academy-grade-reports';
import type { Part } from '@/lib/desk/part';

/**
 * A course's grading policy and gradebook on the founder console (AC-assignments-04). Pure, so the
 * server loader, the route and the browser component share it.
 */
export type { AcademyCourseGradebook, AcademyGradeReport };

export interface GradebookView {
  readonly gradebook: Part<AcademyCourseGradebook>;
  /** The stored grade reports, newest first (AC-assignments-04, report part). */
  readonly reports: Part<AcademyGradeReports>;
  readonly asOf: string;
}

export type GradebookDeskReply =
  | { readonly ok: true; readonly what: string; readonly gradebook: AcademyCourseGradebook }
  | { readonly ok: true; readonly what: string; readonly report: AcademyGradeReport }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
