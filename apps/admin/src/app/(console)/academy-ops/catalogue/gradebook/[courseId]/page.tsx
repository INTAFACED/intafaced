import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyGradebook } from '@/components/academy-gradebook';
import { loadGradebook } from '@/lib/academy/gradebook-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One course's gradebook (AC-assignments-04): the grading policy, and each enrolled learner's scores and total. */
export default async function Page({ params }: { params: Promise<{ courseId: string }> }) {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  const { courseId } = await params;
  if (!UUID.test(courseId)) notFound();
  return <AcademyGradebook courseId={courseId} initial={await loadGradebook(founder, courseId)} />;
}
