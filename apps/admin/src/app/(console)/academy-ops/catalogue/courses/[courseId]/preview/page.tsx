import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyCoursePreview } from '@/components/academy-course-preview';
import { loadPreview } from '@/lib/academy/links-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Preview as new learner (AC-catalogue-03): the course as a reader with no enrolment sees it. Nothing is recorded. */
export default async function Page({ params }: { params: Promise<{ courseId: string }> }) {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  const { courseId } = await params;
  if (!UUID.test(courseId)) notFound();
  return <AcademyCoursePreview courseId={courseId} initial={await loadPreview(founder, courseId)} />;
}
