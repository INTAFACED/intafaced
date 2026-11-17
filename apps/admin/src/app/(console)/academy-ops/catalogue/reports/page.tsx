import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { ReportsDesk } from '@/components/academy-enrolment-desk';
import { loadReports } from '@/lib/academy/enrolment-server';

/** Learner exports (J-academy-15): a background export filtered by tag, kept with its time and hash. */
export default async function Page() {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  return <ReportsDesk initial={await loadReports(founder)} />;
}
