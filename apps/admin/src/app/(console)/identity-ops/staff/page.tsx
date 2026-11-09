import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { StaffDesk } from '@/components/staff-desk';
import { loadStaff } from '@/lib/staff-admin/staff-server';

/** Staff (OPS-admin-access-03): the roster and the two-founder invite (J-ops-console-09 #2). The first paint is svc-identity's answer. */
export const dynamic = 'force-dynamic';

export default async function Page() {
  requireModulePage('identity-ops');
  const founder = await requireFounderPage();
  return <StaffDesk initial={await loadStaff(founder)} userId={founder.session.userId} />;
}
