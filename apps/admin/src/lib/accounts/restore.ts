import 'server-only';
import { createHash } from 'node:crypto';
import { accountControlResultSchema, type AccountControlResult } from '@intafaced/contracts';
import type { DeskRequest } from '@/lib/desk/approval-packet';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { explainRefusal } from '@/lib/desk/refusal-copy';

/**
 * Run an approved account unfreeze (J-ops-console-04 #6) against identity, as the signed-in founder.
 *
 * Identity's restore spends the approval once, in the same transaction that lifts the freeze, and refuses
 * (`restriction_no_four_eyes`, `restriction_approval_mismatch`, `restriction_approval_consumed`) without it. The
 * request id is derived from the approval, so a retry after a lost answer replays identity's first answer instead of
 * making a second attempt.
 */

/** A stable UUID-shaped request id for one approval's run. */
export function restoreRequestId(approvalId: string, operationId: string): string {
  const h = createHash('sha256').update(`identity.account.unfreeze:${approvalId}:${operationId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** What identity answered, as the desk shows it. Only a changed or already-restored account counts as done. */
export function restoreReply(
  request: Extract<DeskRequest, { kind: 'identity.account.unfreeze' }>,
  result: AccountControlResult,
): ExecuteReply {
  if (result.target.area !== 'identity' || result.target.userId !== request.userId || result.action !== 'restore')
    return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  if (result.outcome === 'changed' && !result.after.restricted)
    return {
      ok: true,
      detail: `Identity lifted the freeze on ${request.userId} at version ${result.after.version}${result.approverUserId ? `, approved by ${result.approverUserId.slice(0, 8)}` : ''}.`,
    };
  if (result.outcome === 'noop' && !result.after.restricted)
    return { ok: true, detail: `Identity answered that ${request.userId} was not frozen, so nothing changed.` };
  if (result.outcome === 'refused' || result.outcome === 'conflict') return { ok: false, refusal: explainRefusal(result.code, 409, false) };
  return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
}

export function restoreExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'identity.account.unfreeze') return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const result = await founderCall(
      ctx,
      'identity',
      'accountControls.change',
      'POST',
      {
        requestId: restoreRequestId(ids.approvalId, ids.operationId),
        target: { area: 'identity', userId: request.userId },
        action: 'restore',
        reason: request.reason,
        expectedVersion: request.version,
        approvalId: ids.approvalId,
      },
      parseWith(accountControlResultSchema),
    );
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    return restoreReply(request, result.data);
  };
}
