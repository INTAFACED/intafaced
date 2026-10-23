import type { AcademyLesson, AcademyLessonBlock, AcademyLessonRevision } from '@intafaced/contracts/academy-courses';
import type { Part } from '@/lib/desk/part';

/**
 * The lesson editor (AC-course-structure-03): one outline item's lesson as revisions of ordered blocks, which revision
 * learners see, and the save, revert, publish and duplicate steps. Pure, so the server loader, the route and the browser
 * components share it.
 */
export type { AcademyLesson, AcademyLessonBlock, AcademyLessonRevision };

export interface LessonView {
  readonly lesson: Part<AcademyLesson>;
  readonly asOf: string;
}

export type LessonDeskReply =
  | { readonly ok: true; readonly what: string; readonly lesson: AcademyLesson }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };

/** The revision learners see, or null when none is published. */
export const liveOf = (lesson: AcademyLesson): AcademyLessonRevision | null =>
  lesson.item.liveRevision === null ? null : (lesson.revisions.find((r) => r.revision === lesson.item.liveRevision) ?? null);
