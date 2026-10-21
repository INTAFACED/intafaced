import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CustodyOpsDesk } from '@/components/custody-ops-desk';
import { loadCustodyOps } from '@/lib/custody-ops/server';

/**
 * Custody approvals. The first paint is svc-pay's own answer, each part read on its own and shown as a failure when it cannot be
 * read, never as "nothing is waiting". Works on a phone: this is the approver's screen.
 */
export default async function Page() {
  requireModulePage('custody-ops');
  const founder = await requireFounderPage();
  return <CustodyOpsDesk initial={await loadCustodyOps(founder)} userId={founder.session.userId} />;
}
