import 'server-only';
import { randomUUID } from 'node:crypto';
import { accountTierResultSchema, type AccountTierResult } from '@intafaced/contracts';
import type { DeskRequest } from '@/lib/desk/approval-packet';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { explainRefusal } from '@/lib/desk/refusal-copy';

/**
 * Run an approved tier move (J-ops-console-04 #11) against identity, as the signed-in founder.
 *
 * Identity spends the approval once, in the same transaction that moves the account, and refuses without it
 * (`identity.tier_requires_approver`) or for a tier with blank terms (`identity.tier_terms_unset`, before the approval is
 * spent). Each run takes a new request id, for the reason given in `restore.ts`: identity replays a stored refusal per
 * request id, and single use comes from the approval.
 */

type TierRequest = Extract<DeskRequest, { kind: 'identity.account.tier_move' }>;

/** What identity answered, as the desk shows it. Only a moved account counts as done. */
export function tierReply(request: TierRequest, result: AccountTierResult): ExecuteReply {
  if (result.userId !== request.userId || result.tierId !== request.tierId)
    return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  if (result.outcome === 'changed')
    return {
      ok: true,
      detail: `Identity moved ${request.userId} onto tier ${result.after.tierId} at tier version ${result.after.version}, approved by ${result.approverUserId.slice(0, 8)}.`,
    };
  const refusal = explainRefusal(result.code, 409, false);
  const blank = result.outcome === 'refused' ? result.blankTerms : undefined;
  return { ok: false, refusal: blank ? { ...refusal, body: `${refusal.body} Blank: ${blank.join(', ')}.` } : refusal };
}

export function tierExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'identity.account.tier_move') return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const result = await founderCall(
      ctx,
      'identity',
      'accountControls.tierMove',
      'POST',
      {
        requestId: randomUUID(),
        userId: request.userId,
        tierId: request.tierId,
        reason: request.reason,
        expectedVersion: request.version,
        approvalId: ids.approvalId,
      },
      parseWith(accountTierResultSchema),
    );
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    return tierReply(request, result.data);
  };
}
