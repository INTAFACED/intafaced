import 'server-only';
import { randomUUID } from 'node:crypto';
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
 * (`restriction_no_four_eyes`, `restriction_approval_mismatch`, `restriction_approval_consumed`) without it.
 *
 * Each run takes a new request id. Identity replays a stored answer for a request id it has seen, including a refusal,
 * so an id derived from the approval would pin a run made before the second founder approved to that refusal for good.
 * Single use comes from the approval itself: a second run of a spent approval is refused `restriction_approval_consumed`
 * and changes nothing, and the desk reads the account again after every step.
 */

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
        requestId: randomUUID(),
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
