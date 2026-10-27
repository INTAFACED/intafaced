import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyLessonEditor } from '@/components/academy-lesson-editor';
import { loadLesson } from '@/lib/academy/lessons-server';
import { CourseItemFiles } from '@/components/academy-item-media';
import { loadItemMedia } from '@/lib/academy/media-server';
import { AcademyAssignmentEditor } from '@/components/academy-assignment-editor';
import { loadAssignment } from '@/lib/academy/assignments-server';
import { AcademyQuizEditor } from '@/components/academy-quiz-editor';
import { loadQuiz } from '@/lib/academy/quizzes-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One outline item's lesson: the block editor, its revisions with revert, what learners see, publish and duplicate, and its
 * files. An assignment item also carries its brief (AC-assignments-01), and a quiz item its questions and rules (AC-quizzes-01).
 */
export default async function Page({ params }: { params: Promise<{ courseId: string; itemId: string }> }) {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  const { courseId, itemId } = await params;
  if (!UUID.test(courseId) || !UUID.test(itemId)) notFound();
  const [lesson, media, assignment, quiz] = await Promise.all([
    loadLesson(founder, itemId),
    loadItemMedia(founder, itemId),
    loadAssignment(founder, itemId),
    loadQuiz(founder, itemId),
  ]);
  // Every item but an assignment answers academy.assignment_not_found, and every item but a quiz academy.quiz_not_found;
  // any other answer, a failed read too, is shown.
  const brief =
    assignment.assignment.kind === 'failed' && assignment.assignment.code === 'academy.assignment_not_found' ? null : assignment;
  const quizView = quiz.quiz.kind === 'failed' && quiz.quiz.code === 'academy.quiz_not_found' ? null : quiz;
  return (
    <AcademyLessonEditor
      courseId={courseId}
      itemId={itemId}
      initial={lesson}
      brief={
        brief ? (
          <AcademyAssignmentEditor itemId={itemId} initial={brief} />
        ) : (
          quizView && <AcademyQuizEditor itemId={itemId} initial={quizView} />
        )
      }
      files={<CourseItemFiles itemId={itemId} initial={media} />}
    />
  );
}
