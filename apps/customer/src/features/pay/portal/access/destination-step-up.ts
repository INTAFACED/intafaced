import type { ApiClient, ApiResult } from '../../../../shared/api';
import { confirmWithStepUp } from '../../../account/security-step-up';
import { stepUpCopy } from './step-up-copy';
import { stepUpRefusalText } from './step-up-words';

/** How the owner confirms: the authenticator's 6 digits, or a passkey asked of the browser. */
export type DestinationProof = { code: string } | { passkey: true };

export const isSixDigits = (code: string): boolean => /^\d{6}$/.test(code.trim());

/**
 * Saving where payouts go asks for a fresh confirmation first. svc-pay consumes a same-person approval minted for
 * `pay.step_up.payoutDestination.set` over exactly these fields (`payout-destination-change.ts`), so the confirmation
 * covers this destination and no other. A refusal comes back in plain words.
 */
export async function confirmDestination(
  api: ApiClient,
  destination: { merchantId: string; railId: string; kind: string; ref: string },
  proof: DestinationProof,
): Promise<ApiResult<{ stepUpApprovalId: string }>> {
  if ('code' in proof && !isSixDigits(proof.code))
    return { ok: false, reason: 'error', code: 'portal.local', message: stepUpCopy.t('suCodeShort') };
  const approved = await confirmWithStepUp(
    api,
    { scope: 'pay.step_up.payoutDestination.set', purpose: 'payoutDestination.set', target: destination.ref, fields: { ...destination } },
    'code' in proof ? { totpCode: proof.code.trim() } : { passkey: true },
  );
  return approved.ok ? approved : { ...approved, message: stepUpRefusalText(approved) };
}
