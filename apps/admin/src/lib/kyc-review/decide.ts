import 'server-only';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';

const STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;

/** Identity's KYC record answer, exactly: an id, a known status and when it was reviewed. Anything else is unreadable. */
function readKycRecord(raw: unknown): { id: string; status: (typeof STATUSES)[number]; reviewedAt: string | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !(STATUSES as readonly unknown[]).includes(r.status)) return null;
  if (r.reviewedAt !== null && typeof r.reviewedAt !== 'string') return null;
  return { id: r.id, status: r.status as (typeof STATUSES)[number], reviewedAt: r.reviewedAt as string | null };
}

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
      readKycRecord,
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
