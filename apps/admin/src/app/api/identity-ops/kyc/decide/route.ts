import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { kycCaseDecideExecute } from '@/lib/kyc-review/decide';

/**
 * Deciding one verification case (I-kyc-compliance-01 and -02), from the case's review panel.
 *
 * POST runs one step of a two-person request: the reviewer asks for a decision on a record, a different person approves that
 * record and that decision, and the run records it at identity (`kyc.approve` / `kyc.reject`), which spends the approval once.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('identity-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['identity.kyc_case.reject', 'identity.kyc_case.approve'],
    check: () => null,
    execute: kycCaseDecideExecute(session),
  });
}
