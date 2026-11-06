import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { OpsDesk } from '@/components/ops-desk';
import { MARKET_DESK } from '@/lib/ops-desk/catalog';
import { loadDesk } from '@/lib/ops-desk/server';

/**
 * Market listing review (J-more-catalogue-04, MC-market-03): the More modules desk's market section on its own page. Two
 * founders approve or reject each waiting listing and take listings down, each as a two-founder request. It reads only
 * that section, through the More modules API.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  return <OpsDesk spec={MARKET_DESK} initial={await loadDesk(founder, 'more', new Date(), ['market'])} userId={founder.session.userId} />;
}
