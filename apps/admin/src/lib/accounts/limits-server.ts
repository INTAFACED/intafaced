import 'server-only';
import { randomUUID } from 'node:crypto';
import { accountLimitResultSchema, type AccountLimitResult } from '@intafaced/contracts';
import type { DeskRequest } from '@/lib/desk/approval-packet';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { limitsReply } from './limits';

/**
 * Run an approved limit override above the owner ceiling (J-ops-console-04 #12) against identity, as the signed-in
 * founder. Identity spends the approval once, in the same transaction that sets the override. Each run takes a new request
 * id, for the reason given in `restore.ts`: identity replays a stored refusal per request id, and single use comes from the
 * approval.
 */

type LimitRequest = Extract<DeskRequest, { kind: 'identity.account.limit_override' }>;

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** What identity answered to an approved raise, as the desk shows it. Only a set override counts as done. */
export function limitRaiseReply(request: LimitRequest, result: AccountLimitResult): ExecuteReply {
  if (result.userId !== request.userId || result.rail !== request.rail || result.assetId !== request.assetId || result.action !== 'set')
    return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  if (result.outcome === 'changed') return { ok: true, detail: limitsReply(result).text };
  return { ok: false, refusal: explainRefusal(result.code, 409, false) };
}

export function limitsExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'identity.account.limit_override')
      return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const result = await founderCall(
      ctx,
      'identity',
      'accountControls.limitsSet',
      'POST',
      {
        requestId: randomUUID(),
        userId: request.userId,
        rail: request.rail,
        assetId: request.assetId,
        perTx: request.perTx,
        rolling24h: request.rolling24h,
        expiresAt: request.expiresAt,
        reason: request.reason,
        expectedVersion: request.version,
        approvalId: ids.approvalId,
      },
      parseWith(accountLimitResultSchema),
    );
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    return limitRaiseReply(request, result.data);
  };
}

/** Identity's answer to a direct set or clear, in words, or why it could not be had. */
export function limitsAnswer(result: FounderCallResult<AccountLimitResult>, userId: string): Response {
  if (result.kind !== 'ok') {
    const failed = failureRefusal('svc-identity', 'identity', result);
    const refusal = failed.ok ? null : failed.refusal;
    return Response.json(
      {
        ok: false,
        text: refusal ? `${refusal.title}. ${refusal.body}${refusal.code ? ` (${refusal.code})` : ''}` : 'Identity did not answer.',
      },
      { status: 502, headers: NO_STORE },
    );
  }
  if (result.data.userId !== userId)
    return Response.json(
      { ok: false, text: 'Identity answered for another customer. Read the account again.' },
      { status: 502, headers: NO_STORE },
    );
  const reply = limitsReply(result.data);
  return Response.json({ ...reply, outcome: result.data.outcome }, { status: reply.ok ? 200 : 409, headers: NO_STORE });
}
