import type {
  AcademyAdminCourseQuiz,
  AcademyCourseQuizAttempts,
  AcademyCourseQuizQuestion,
  AcademyRescoreCourseQuizResult,
} from '@intafaced/contracts/academy-course-quizzes';
import type { Part } from '@/lib/desk/part';

/**
 * A quiz's finished attempts and their score changes on the founder console (AC-quizzes-04): attempts under aliases with
 * points per question, overrides with a reason, key fixes as a new revision and rescores. Pure, so the server loader, the
 * route and the browser component share it.
 */
export type { AcademyAdminCourseQuiz, AcademyCourseQuizAttempts, AcademyCourseQuizQuestion, AcademyRescoreCourseQuizResult };

export interface QuizTrailView {
  readonly quiz: Part<AcademyAdminCourseQuiz>;
  readonly attempts: Part<AcademyCourseQuizAttempts>;
  readonly asOf: string;
}

export type QuizTrailReply =
  | {
      readonly ok: true;
      readonly what: string;
      readonly view: QuizTrailView;
      readonly rescored?: AcademyRescoreCourseQuizResult['rescored'];
    }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };
