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
import { itemPanels } from '@/lib/academy/item-panels';

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
  const panels = itemPanels(lesson, assignment, quiz);
  return (
    <AcademyLessonEditor
      courseId={courseId}
      itemId={itemId}
      initial={lesson}
      brief={
        <>
          {panels.assignment && <AcademyAssignmentEditor itemId={itemId} initial={panels.assignment} />}
          {panels.quiz && <AcademyQuizEditor itemId={itemId} initial={panels.quiz} />}
        </>
      }
      files={<CourseItemFiles itemId={itemId} initial={media} />}
    />
  );
}
