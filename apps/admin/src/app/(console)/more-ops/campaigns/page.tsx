import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CampaignsDesk } from '@/components/campaigns-desk';
import { loadCampaignsDesk } from '@/lib/campaigns-ops/builder-server';

/** The campaigns desk: the count in each state, the drafts, every campaign and the calendar, as svc-campaigns answered. */
export default async function Page() {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  return <CampaignsDesk initial={await loadCampaignsDesk(founder)} />;
}
