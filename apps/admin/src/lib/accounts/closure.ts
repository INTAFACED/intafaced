import 'server-only';
import { randomUUID } from 'node:crypto';
import { type AccountClosureResult } from '@intafaced/contracts';
import {
  type DeskRequest,
  type ExecuteFn,
  type ExecuteReply,
  explainRefusal,
  failureRefusal,
  type FounderCallContext,
  founderRecordCall,
} from '@/lib/desk';
import { describeBlockers } from './closure-blockers';
import { IDENTITY_ACCOUNT_CONTROLS_CLOSURE } from '@intafaced/contracts/identity-account-controls-procedures';

/**
 * Run an approved staff close or reopen (J-ops-console-04 #7) against identity, as the signed-in founder.
 *
 * Identity spends the approval once, in the same transaction that closes or reopens the account, and refuses without
 * it (`identity.close_requires_approver`). A close refuses while the account still has open products or balances,
 * before the approval is spent. Each run takes a new request id, for the reason given in `restore.ts`: identity
 * replays a stored refusal per request id, and single use comes from the approval.
 */

type ClosureRequest = Extract<DeskRequest, { kind: 'identity.account.close' | 'identity.account.reopen' }>;

/** What identity answered, as the desk shows it. Only a changed account counts as done. */
export function closureReply(request: ClosureRequest, result: AccountClosureResult): ExecuteReply {
  const action = request.kind === 'identity.account.close' ? 'close' : 'reopen';
  if (result.userId !== request.userId || result.action !== action)
    return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  if (result.outcome === 'changed')
    return {
      ok: true,
      detail: `Identity ${action === 'close' ? 'closed' : 'reopened'} ${request.userId} at version ${result.after.version}, approved by ${result.approverUserId.slice(0, 8)}.`,
    };
  const refusal = explainRefusal(result.code, 409, false);
  const still = result.outcome === 'refused' ? describeBlockers(result.blockers) : null;
  return { ok: false, refusal: still ? { ...refusal, body: `${refusal.body} Still open: ${still}.` } : refusal };
}

export function closureExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'identity.account.close' && request.kind !== 'identity.account.reopen')
      return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const common = {
      requestId: randomUUID(),
      userId: request.userId,
      reason: request.reason,
      expectedVersion: request.version,
      approvalId: ids.approvalId,
    };
    const result = await founderRecordCall(
      ctx,
      IDENTITY_ACCOUNT_CONTROLS_CLOSURE,
      request.kind === 'identity.account.close'
        ? { ...common, action: 'close', reasonCode: request.reasonCode }
        : { ...common, action: 'reopen' },
    );
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    return closureReply(request, result.data);
  };
}
