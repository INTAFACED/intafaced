import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyLessonEditor } from '@/components/academy-lesson-editor';
import { loadLesson } from '@/lib/academy/lessons-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One outline item's lesson: the block editor, its revisions with revert, what learners see, publish and duplicate. */
export default async function Page({ params }: { params: Promise<{ courseId: string; itemId: string }> }) {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  const { courseId, itemId } = await params;
  if (!UUID.test(courseId) || !UUID.test(itemId)) notFound();
  return <AcademyLessonEditor courseId={courseId} itemId={itemId} initial={await loadLesson(founder, itemId)} />;
}
