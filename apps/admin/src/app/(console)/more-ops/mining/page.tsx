import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { OpsDesk } from '@/components/ops-desk';
import { MINING_DESK } from '@/lib/ops-desk/catalog';
import { loadDesk } from '@/lib/ops-desk/server';

/**
 * Mining operations: the More modules desk's mining section on its own page, with the common eight sections above it. The reads
 * are the More modules read (one call per service, as on that desk); only the mining part is shown here.
 */
export default async function Page() {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  return <OpsDesk spec={MINING_DESK} initial={await loadDesk(founder, 'more')} userId={founder.session.userId} />;
}
