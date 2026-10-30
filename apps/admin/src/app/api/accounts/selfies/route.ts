import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { handleStep } from '@/lib/desk/step-route';
import { kycSelfieDecideExecute } from '@/lib/kyc-selfies/decide';

/**
 * Accepting or rejecting one selfie (I-kyc-compliance-09), from the customer record's documents tab.
 *
 * POST runs one step of a two-founder request: the first founder asks for a decision on a selfie, a different founder approves
 * that selfie and that decision, and the run records it at identity (`kyc.selfie.decide`), which spends the approval once.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['identity.kyc_selfie.decide'],
    check: () => null,
    execute: kycSelfieDecideExecute(session),
  });
}
