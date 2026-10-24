import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyLessonEditor } from '@/components/academy-lesson-editor';
import { loadLesson } from '@/lib/academy/lessons-server';
import { CourseItemFiles } from '@/components/academy-item-media';
import { loadItemMedia } from '@/lib/academy/media-server';
import { AcademyAssignmentEditor } from '@/components/academy-assignment-editor';
import { loadAssignment } from '@/lib/academy/assignments-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One outline item's lesson: the block editor, its revisions with revert, what learners see, publish and duplicate, and its
 * files. An assignment item also carries its brief (AC-assignments-01).
 */
export default async function Page({ params }: { params: Promise<{ courseId: string; itemId: string }> }) {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  const { courseId, itemId } = await params;
  if (!UUID.test(courseId) || !UUID.test(itemId)) notFound();
  const [lesson, media, assignment] = await Promise.all([
    loadLesson(founder, itemId),
    loadItemMedia(founder, itemId),
    loadAssignment(founder, itemId),
  ]);
  // Every item but an assignment answers academy.assignment_not_found; any other answer, a failed read too, is shown.
  const brief =
    assignment.assignment.kind === 'failed' && assignment.assignment.code === 'academy.assignment_not_found' ? null : assignment;
  return (
    <AcademyLessonEditor
      courseId={courseId}
      itemId={itemId}
      initial={lesson}
      brief={brief && <AcademyAssignmentEditor itemId={itemId} initial={brief} />}
      files={<CourseItemFiles itemId={itemId} initial={media} />}
    />
  );
}
