import { FounderOpsShell } from '@/components/founder-ops/shell';
import { StaffRosterDesk } from '@/components/system-staff/roster';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { isStaffIdParam } from '@/lib/system-staff/model';
import { loadRoster } from '@/lib/system-staff/server';

/**
 * Staff and founders (`/system/users`, the founder screen "Founders and access" extended to the staff roster;
 * OPS-admin-access-03 step 3). The signed-in founder and the enrolment door, the roster svc-identity stores and the
 * two-founder invite. The first paint is svc-identity's own answer with the time it was read.
 */
export const dynamic = 'force-dynamic';

export default async function StaffUsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('merchants');
  const founder = await requireFounderPage();
  const raw = (await searchParams).cursor;
  const cursor = typeof raw === 'string' && isStaffIdParam(raw) ? raw : null;
  const initial = await loadRoster(founder, cursor ?? undefined);
  return (
    <FounderOpsShell showBadge={false}>
      <StaffRosterDesk initial={initial} cursor={cursor} userId={founder.session.userId} expiresAt={founder.session.expiresAt} />
    </FounderOpsShell>
  );
}
