import { notFound } from 'next/navigation';
import { FounderOpsShell } from '@/components/founder-ops/shell';
import { StaffMemberDesk } from '@/components/system-staff/member';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { isStaffIdParam } from '@/lib/system-staff/model';
import { loadStaffMember } from '@/lib/system-staff/server';

/**
 * One staff member (`/system/users/:userId`, OPS-admin-access-03 step 3): the record, roles with assign and unassign,
 * disable and remove, and the access overview. The path segment is the staff id svc-identity hands out in the roster.
 */
export const dynamic = 'force-dynamic';

export default async function StaffMemberPage({ params }: { params: Promise<{ userId: string }> }) {
  requireModulePage('merchants');
  const founder = await requireFounderPage();
  const { userId: segment } = await params;
  let staffId: string;
  try {
    staffId = decodeURIComponent(segment);
  } catch {
    notFound();
  }
  if (!isStaffIdParam(staffId)) notFound();
  return (
    <FounderOpsShell showBadge={false}>
      <StaffMemberDesk initial={await loadStaffMember(founder, staffId)} userId={founder.session.userId} />
    </FounderOpsShell>
  );
}
