import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyModerationDesk } from '@/components/academy-moderation-desk';
import { loadModeration } from '@/lib/academy/team-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The moderation desk (J-academy-18): reported discussion posts, deleting one with a reason, and every moderation action. */
export default async function Page({ searchParams }: { searchParams: Promise<{ courseId?: string }> }) {
  requireModulePage('academy-ops');
  const operator = await requireFounderPage();
  const { courseId } = await searchParams;
  const course = typeof courseId === 'string' && UUID.test(courseId) ? courseId.toLowerCase() : null;
  return <AcademyModerationDesk key={course ?? 'all'} initial={await loadModeration(operator, course)} />;
}
