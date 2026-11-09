import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { moduleDisabledResponse } from '@/lib/modules';
import { loadStaff, staffInviteExecute } from '@/lib/staff-admin/staff-server';

/**
 * The staff directory (OPS-admin-access-03, J-ops-console-09 #2). GET reads the roster. POST runs one step of an invite:
 * identity judges it by the invite policy row, a different founder approves the exact person, and svc-identity spends
 * the approval once when the invite is written and the one-time link mailed.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadStaff(session), { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, { kinds: ['identity.staff.invite'], check: () => null, execute: staffInviteExecute(session) });
}
