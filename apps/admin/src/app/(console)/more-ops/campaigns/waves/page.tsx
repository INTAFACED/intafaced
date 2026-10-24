import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CampaignsWavesDesk } from '@/components/campaigns-waves-desk';
import { loadWaves } from '@/lib/campaigns-ops/waves-server';

/**
 * Waitlist waves: the owner's wave size, who is still waiting, the waves already released and the two-person release of the
 * next one. The first paint is svc-identity's own answer with the time it was read.
 */
export default async function Page() {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  return <CampaignsWavesDesk initial={await loadWaves(founder)} userId={founder.session.userId} />;
}
