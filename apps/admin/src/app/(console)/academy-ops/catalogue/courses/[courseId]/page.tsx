import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyCourseDesk } from '@/components/academy-courses-desk';
import { loadCourseDetail } from '@/lib/academy/courses-server';
import { AcademyCourseRelease } from '@/components/academy-course-release';
import { loadRelease } from '@/lib/academy/release-server';
import { AcademyCourseItemRules } from '@/components/academy-course-item-rules';
import { loadItemRules } from '@/lib/academy/item-rules-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One course: its details, the draft's edit form, Publish with a reason, its history, its release and pacing, and its prerequisites and due dates. */
export default async function Page({ params }: { params: Promise<{ courseId: string }> }) {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  const { courseId } = await params;
  if (!UUID.test(courseId)) notFound();
  const [detail, release, rules] = await Promise.all([
    loadCourseDetail(founder, courseId),
    loadRelease(founder, courseId),
    loadItemRules(founder, courseId),
  ]);
  return (
    <>
      <AcademyCourseDesk courseId={courseId} initial={detail} />
      <AcademyCourseRelease courseId={courseId} initial={release} />
      <AcademyCourseItemRules courseId={courseId} initial={rules} />
    </>
  );
}
