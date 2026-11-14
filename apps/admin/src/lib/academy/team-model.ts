import type { AcademyCourseList } from '@intafaced/contracts/academy-courses';
import type { AcademyCourseTeam, AcademyModerationQueue, AcademyRoles } from '@intafaced/contracts/academy-team';
import type { Part } from '@/lib/desk/part';

/**
 * The moderation desk and the course team desk (J-academy-18: AC-rooms-02, AC-roles-01). Pure, so the server loader,
 * the routes and the browser components share it.
 */
export type { AcademyCourseTeam, AcademyModerationQueue, AcademyRoles };

export interface ModerationView {
  readonly courseId: string | null;
  readonly queue: Part<AcademyModerationQueue>;
  readonly courses: Part<AcademyCourseList>;
  readonly asOf: string;
}

export interface TeamView {
  readonly courseId: string | null;
  readonly team: Part<AcademyCourseTeam>;
  readonly roles: Part<AcademyRoles>;
  readonly courses: Part<AcademyCourseList>;
  readonly asOf: string;
}

export type TeamDeskReply =
  | { readonly ok: true; readonly what: string }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
