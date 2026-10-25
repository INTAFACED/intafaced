import type { AcademyCourseGradebook } from '@intafaced/contracts/academy-course-gradebook';
import type { Part } from '@/lib/desk/part';

/**
 * A course's grading policy and gradebook on the founder console (AC-assignments-04). Pure, so the
 * server loader, the route and the browser component share it.
 */
export type { AcademyCourseGradebook };

export interface GradebookView {
  readonly gradebook: Part<AcademyCourseGradebook>;
  readonly asOf: string;
}

export type GradebookDeskReply =
  | { readonly ok: true; readonly what: string; readonly gradebook: AcademyCourseGradebook }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
