import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { OpsDesk } from '@/components/ops-desk';
import { DESKS } from '@/lib/ops-desk/catalog';
import { loadDesk } from '@/lib/ops-desk/server';

/**
 * Personal Pay operations. The first paint is svc-bank's own answers, each with the time it was read; a read that is refused or
 * down says so in words, and what the service cannot give is listed as not available with the reason.
 */
export default async function Page() {
  requireModulePage('pay-ops');
  const founder = await requireFounderPage();
  return <OpsDesk spec={DESKS.pay} initial={await loadDesk(founder, 'pay')} userId={founder.session.userId} />;
}
