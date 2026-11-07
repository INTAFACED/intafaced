import 'server-only';
import { z } from 'zod';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';

const kycRecord = z.object({
  id: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  reviewedAt: z.string().nullable(),
});

/**
 * Decide one verification case (I-kyc-compliance-01 and -02) at identity, as the signed-in reviewer, after a second person
 * approved that record and that decision. Identity checks the reason is on the owner's list before it spends the approval,
 * refuses if either person is the customer, and returns the stored result when the same reject runs again. It reports done
 * only when the record identity returns holds the decision that was asked for.
 */
export function kycCaseDecideExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'identity.kyc_case.reject' && request.kind !== 'identity.kyc_case.approve')
      return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const reject = request.kind === 'identity.kyc_case.reject';
    const result = await founderCall(
      ctx,
      'identity',
      reject ? 'kyc.reject' : 'kyc.approve',
      'POST',
      reject
        ? {
            recordId: request.recordId,
            reasonCode: request.reasonCode,
            noteVisible: false,
            approvalId: ids.approvalId,
            operationId: ids.operationId,
          }
        : { recordId: request.recordId, approvalId: ids.approvalId, operationId: ids.operationId },
      parseWith(kycRecord),
    );
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    const want = reject ? 'rejected' : 'approved';
    if (result.data.id !== request.recordId || result.data.status !== want)
      return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
    return {
      ok: true,
      detail: `Identity recorded request ${result.data.id} as ${want}${reject ? ` with reason ${request.reasonCode}` : ''}${result.data.reviewedAt ? ` at ${result.data.reviewedAt}` : ''}.`,
    };
  };
}
