import type { AcademyAdminCourseQuiz } from '@intafaced/contracts/academy-course-quizzes';
import type { Part } from '@/lib/desk/part';

/**
 * A quiz item on the founder console (AC-quizzes-01): its questions, attempt rules, state and what stops Publish. Pure, so
 * the server loader, the route and the browser component share it.
 */
export type { AcademyAdminCourseQuiz };

export interface QuizView {
  readonly quiz: Part<AcademyAdminCourseQuiz>;
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
