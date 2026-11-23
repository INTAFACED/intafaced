import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { kycApproveExecute } from '@/lib/kyc-cases/approve';

/**
 * Approving one pending verification (I-kyc-compliance-07), from a verification case row.
 *
 * POST runs one step of a two-founder request: the first founder asks to approve a verification, a different founder approves
 * that record, and the run approves it at identity (`kyc.approve`), which spends the approval once.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['identity.kyc.approve'],
    check: () => null,
    execute: kycApproveExecute(session),
  });
}
