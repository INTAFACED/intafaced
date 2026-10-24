import 'server-only';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { freezeDetail, readFreezeAnswer, readUnfreezeAnswer, unfreezeDetail, type DepositFreezeRequest } from './model';

/**
 * svc-pay deposit address freezes (`founderAdmin.depositFreezes.*`), written as the signed-in founder. svc-pay checks the caller is
 * a live founder and records which one; a lift spends the second founder's identity approval and refuses its approver as the one
 * who runs it. This console adds no authority.
 */

export async function freezeDepositAddress(ctx: FounderCallContext, request: DepositFreezeRequest): Promise<ExecuteReply> {
  const result = await founderCall(ctx, 'pay', 'founderAdmin.depositFreezes.freeze', 'POST', request, readFreezeAnswer);
  if (result.kind !== 'ok') return failureRefusal('svc-pay', 'pay', result);
  const answer = result.data;
  if (answer.userId !== request.userId || answer.networkId !== request.networkId || answer.address !== request.address.toLowerCase())
    return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  return { ok: true, detail: freezeDetail(request.address, answer) };
}

export function depositUnfreezeExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'pay.deposit_address.unfreeze') return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const result = await founderCall(
      ctx,
      'pay',
      'founderAdmin.depositFreezes.unfreeze',
      'POST',
      {
        userId: request.userId,
        networkId: request.networkId,
        address: request.address,
        freezeId: request.freezeId,
        reason: request.reason,
        approvalId: ids.approvalId,
        operationId: ids.operationId,
      },
      readUnfreezeAnswer,
    );
    if (result.kind !== 'ok') return failureRefusal('svc-pay', 'pay', result);
    if (result.data.freezeId !== request.freezeId) return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
    return { ok: true, detail: unfreezeDetail(request.address, result.data.released, result.data.credited) };
  };
}
