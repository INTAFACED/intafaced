import { adminBffSession } from '@/lib/admin-bff-gate';
import { STAFF_REQUEST_KINDS } from '@/lib/desk/approval-staff';
import { handleStep } from '@/lib/desk/step-route';
import { moduleDisabledResponse } from '@/lib/modules';
import { isStaffIdParam } from '@/lib/system-staff/model';
import { loadRoles, loadRoster, loadStaffMember, staffExecute, staffPrecheck } from '@/lib/system-staff/server';

/**
 * The staff screens' BFF (`/system/users`, `/system/users/:userId`, `/system/roles`; OPS-admin-access-03 step 3).
 *
 * GET re-reads what svc-identity stores (`?view=roster[&cursor=]`, `?view=member&staffId=`, `?view=roles`): after any step,
 * and after a lost reply, the page shows this read, never what it guessed.
 *
 * POST runs one step of a two-founder staff change, exactly as the other desks do: identity issues the approval, a different
 * founder signs it, and svc-identity spends it once when the change runs. While svc-identity does not serve the staff
 * procedures a propose is refused before any approval is made, and a run is refused with nothing spent.
 */

export const dynamic = 'force-dynamic';
const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('merchants');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const url = new URL(request.url);
  const view = url.searchParams.get('view');
  if (view === 'roster') {
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null && !isStaffIdParam(cursor)) return Response.json({ error: 'cursor_invalid' }, { status: 400, headers: NO_STORE });
    return Response.json(await loadRoster(session, cursor ?? undefined), { headers: NO_STORE });
  }
  if (view === 'member') {
    const staffId = url.searchParams.get('staffId') ?? '';
    if (!isStaffIdParam(staffId)) return Response.json({ error: 'staff_id_invalid' }, { status: 400, headers: NO_STORE });
    return Response.json(await loadStaffMember(session, staffId), { headers: NO_STORE });
  }
  if (view === 'roles') return Response.json(await loadRoles(session), { headers: NO_STORE });
  return Response.json({ error: 'view_invalid' }, { status: 400, headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('merchants');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: STAFF_REQUEST_KINDS,
    check: () => null,
    precheck: staffPrecheck(session),
    execute: staffExecute(session),
  });
}
