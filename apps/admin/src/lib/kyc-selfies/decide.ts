import 'server-only';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { readSelfie } from './selfie';

/**
 * Decide one approved selfie (I-kyc-compliance-09) at identity, as the signed-in founder.
 *
 * Identity checks the approval is for this selfie and this decision, that neither the caller nor the approval's two founders
 * is the person, and that the selfie still waits; then it spends the approval and records the decision.
 */
export function kycSelfieDecideExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'identity.kyc_selfie.decide') return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const result = await founderCall(
      ctx,
      'identity',
      'kyc.selfie.decide',
      'POST',
      { selfieId: request.selfieId, decision: request.decision, approvalId: ids.approvalId, operationId: ids.operationId },
      readSelfie,
    );
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    const selfie = result.data;
    if (selfie.id !== request.selfieId || selfie.status !== request.decision)
      return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
    return {
      ok: true,
      detail: `Identity recorded selfie ${selfie.id} as ${selfie.status}${selfie.decidedAt ? ` at ${selfie.decidedAt}` : ''}.`,
    };
  };
}
