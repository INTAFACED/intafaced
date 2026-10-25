import type { AcademyCourseRelease } from '@intafaced/contracts/academy-course-release';
import type { Part } from '@/lib/desk/part';

/**
 * A course's pacing and its sections' release rules on the founder console (AC-release-access-01). Pure, so the server
 * loader, the route and the browser component share it.
 */
export type { AcademyCourseRelease };

export interface ReleaseView {
  readonly release: Part<AcademyCourseRelease>;
  readonly asOf: string;
}

export type ReleaseDeskReply =
  | { readonly ok: true; readonly what: string; readonly release: AcademyCourseRelease }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
