import 'server-only';
import { type ExecuteFn, explainRefusal, failureRefusal, type FounderCallContext, founderRecordRead } from '@/lib/desk';
import { IDENTITY_KYC_APPROVE } from '@intafaced/contracts/identity-kyc-procedures';
import { kycRecordOutput } from '@intafaced/contracts/identity-call-schemas';
type KycRecord = ReturnType<typeof kycRecordOutput.parse>;

/** Reads identity's answer to `kyc.approve` with the contract's own schema. Pure. */
export function readKycRecord(raw: unknown): KycRecord | null {
  const parsed = kycRecordOutput.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Approve one pending verification (I-kyc-compliance-07) at identity, as the signed-in founder.
 *
 * Identity checks the approval is for this record, that neither the caller nor the approval's two founders is the person, and
 * that the record still waits; then it spends the approval, marks it approved and makes the mapped capabilities active.
 */
export function kycApproveExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'identity.kyc.approve') return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const result = await founderRecordRead(
      ctx,
      IDENTITY_KYC_APPROVE,
      { recordId: request.recordId, approvalId: ids.approvalId, operationId: ids.operationId },
      readKycRecord,
    );
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    const record = result.data;
    if (record.id !== request.recordId || record.status !== 'approved')
      return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
    return {
      ok: true,
      detail: `Identity approved verification ${record.id} at level ${record.tier}${record.reviewedAt ? ` at ${record.reviewedAt}` : ''}.`,
    };
  };
}
