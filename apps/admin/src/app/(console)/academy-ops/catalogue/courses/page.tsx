import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyCoursesDesk } from '@/components/academy-courses-desk';
import { loadCourseList } from '@/lib/academy/courses-server';

/** The courses staff created, and the form that creates one as a draft. The first paint is svc-academy's own answer. */
export default async function Page() {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  return <AcademyCoursesDesk initial={await loadCourseList(founder)} />;
}
