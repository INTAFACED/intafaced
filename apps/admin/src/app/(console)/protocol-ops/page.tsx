import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { OpsDesk } from '@/components/ops-desk';
import { DESKS } from '@/lib/ops-desk/catalog';
import { loadDesk } from '@/lib/ops-desk/server';

/**
 * Protocol operations. The first paint is the protocol, indexer and DEX services' own answers, each with the time it was read; a
 * service that cannot be reached is named ("could not load chain status") and the named blockers count it as a blocker.
 */
export default async function Page() {
  requireModulePage('protocol-ops');
  const founder = await requireFounderPage();
  return <OpsDesk spec={DESKS.protocol} initial={await loadDesk(founder, 'protocol')} userId={founder.session.userId} />;
}
