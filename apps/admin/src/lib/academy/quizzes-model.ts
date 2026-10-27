import type { AcademyAdminCourseQuiz, AcademyCourseQuizReview } from '@intafaced/contracts/academy-course-quizzes';
import type { Part } from '@/lib/desk/part';

/**
 * A quiz item on the founder console (AC-quizzes-01, 02): its questions, attempt rules, state, what stops Publish and the
 * attempts waiting for an essay score. Pure, so
 * the server loader, the route and the browser component share it.
 */
export type { AcademyAdminCourseQuiz, AcademyCourseQuizReview };

export interface QuizView {
  readonly quiz: Part<AcademyAdminCourseQuiz>;
  /** Null when the quiz itself could not be read. */
  readonly reviews: Part<AcademyCourseQuizReview[]> | null;
  readonly asOf: string;
}

export type QuizDeskReply =
  | { readonly ok: true; readonly what: string; readonly quiz: AcademyAdminCourseQuiz }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
