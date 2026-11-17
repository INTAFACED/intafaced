import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyTeamDesk } from '@/components/academy-team-desk';
import { loadTeam } from '@/lib/academy/team-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The course team desk (J-academy-18): who holds which role on a course, two-founder role changes, and custom roles. */
export default async function Page({ searchParams }: { searchParams: Promise<{ courseId?: string }> }) {
  requireModulePage('academy-ops');
  const operator = await requireFounderPage();
  const { courseId } = await searchParams;
  const course = typeof courseId === 'string' && UUID.test(courseId) ? courseId.toLowerCase() : null;
  return <AcademyTeamDesk key={course ?? 'all'} initial={await loadTeam(operator, course)} />;
}
