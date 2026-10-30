import type { AcademyBulkGradeResult, AcademyGradingQueue, AcademyGradingRow } from '@intafaced/contracts/academy-courses';
import type { Part } from '@/lib/desk/part';

/**
 * The grading queue of one assignment on the founder console (AC-assignments-02): learners under aliases, their newest
 * hand-in, the peer reviews it received, its grade and who holds it. Pure, so the server loader, the route and the
 * browser component share it.
 */
export type { AcademyBulkGradeResult, AcademyGradingQueue, AcademyGradingRow };

export interface GradingView {
  readonly queue: Part<AcademyGradingQueue>;
  readonly asOf: string;
}

export type GradingDeskReply =
  | { readonly ok: true; readonly what: string; readonly queue: AcademyGradingQueue; readonly bulk?: AcademyBulkGradeResult }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
