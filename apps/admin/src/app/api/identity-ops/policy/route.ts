import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { moduleDisabledResponse } from '@/lib/modules';
import { loadPolicyRows, policySetExecute } from '@/lib/staff-admin/staff-server';

/**
 * Approval policy rows (OPS-change-control-01, J-ops-console-09 #1). GET reads every governed type's row as svc-identity
 * reads it now. POST runs one step of a two-founder row change: identity issues the approval, a different founder
 * approves the exact row, and svc-identity spends it once when the row is written.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadPolicyRows(session), { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, { kinds: ['identity.approval_policy.set'], check: () => null, execute: policySetExecute(session) });
}
