import type { AcademyAdminAssignment } from '@intafaced/contracts/academy-courses';
import type { Part } from '@/lib/desk/part';

/**
 * An assignment item's brief on the founder console (AC-assignments-01): instructions, points, due date and what a
 * learner hands in. Pure, so the server loader, the route and the browser component share it.
 */
export type { AcademyAdminAssignment };

export interface AssignmentView {
  readonly assignment: Part<AcademyAdminAssignment>;
  readonly asOf: string;
}

export type AssignmentDeskReply =
  | { readonly ok: true; readonly what: string; readonly assignment: AcademyAdminAssignment }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
