import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { GovernancePanel } from '@/components/token-governance/governance-panel';
import { readGovernance } from '@/lib/token-governance/server';

/** Token governance: the voting delay and period and the governance roles, each set by two founders (J-more-catalogue-10). */
export const dynamic = 'force-dynamic';

export default async function Page() {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  return <GovernancePanel read={await readGovernance(founder)} userId={founder.session.userId} />;
}
