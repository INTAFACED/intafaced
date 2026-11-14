import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyReports } from '@/components/academy-reports';
import { loadReports } from '@/lib/academy/analytics-server';

/** The Academy reports centre (AC-analytics-02): request, watch, abort, download and delete report tasks. */
export default async function Page() {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  return <AcademyReports initial={await loadReports(founder)} />;
}
