import 'server-only';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { readReleaseAnswer, readWaitAnswer, travelRuleDetail, type TravelRuleRequest } from './model';

/**
 * svc-pay's inbound travel rule on deposits (`founderAdmin.depositTravelRule.*`), written as the signed-in founder. svc-pay checks
 * the caller is a live founder, records which one, and refuses a release of an undeclared deposit. This console adds no authority.
 */
export async function actOnTravelRule(ctx: FounderCallContext, request: TravelRuleRequest): Promise<ExecuteReply> {
  const input = { depositId: request.depositId, reason: request.reason };
  if (request.action === 'wait') {
    const result = await founderCall(ctx, 'pay', 'founderAdmin.depositTravelRule.markCounterpartyPending', 'POST', input, readWaitAnswer);
    if (result.kind !== 'ok') return failureRefusal('svc-pay', 'pay', result);
    if (result.data.depositId !== request.depositId) return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
    return { ok: true, detail: travelRuleDetail('wait', result.data) };
  }
  const result = await founderCall(ctx, 'pay', 'founderAdmin.depositTravelRule.release', 'POST', input, readReleaseAnswer);
  if (result.kind !== 'ok') return failureRefusal('svc-pay', 'pay', result);
  if (result.data.depositId !== request.depositId) return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  return { ok: true, detail: travelRuleDetail('release', result.data) };
}
