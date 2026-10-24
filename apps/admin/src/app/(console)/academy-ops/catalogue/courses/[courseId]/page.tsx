import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyCourseDesk } from '@/components/academy-courses-desk';
import { loadCourseDetail } from '@/lib/academy/courses-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One course: its details, the draft's edit form, Publish with a reason, and its history. */
export default async function Page({ params }: { params: Promise<{ courseId: string }> }) {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  const { courseId } = await params;
  if (!UUID.test(courseId)) notFound();
  return <AcademyCourseDesk courseId={courseId} initial={await loadCourseDetail(founder, courseId)} />;
}
