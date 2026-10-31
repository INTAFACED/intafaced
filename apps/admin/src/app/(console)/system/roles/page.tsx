import { FounderOpsShell } from '@/components/founder-ops/shell';
import { StaffRolesDesk } from '@/components/system-staff/roles';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { loadRoles } from '@/lib/system-staff/server';

/** Staff roles (`/system/roles`, OPS-admin-access-03 step 3): the roles svc-identity stores and the custom-role editor proposal. */
export const dynamic = 'force-dynamic';

export default async function StaffRolesPage() {
  requireModulePage('merchants');
  const founder = await requireFounderPage();
  return (
    <FounderOpsShell showBadge={false}>
      <StaffRolesDesk initial={await loadRoles(founder)} userId={founder.session.userId} />
    </FounderOpsShell>
  );
}
