import 'server-only';
import { randomUUID } from 'node:crypto';
import { accountArchiveResultSchema, type AccountArchiveResult } from '@intafaced/contracts';
import type { DeskRequest } from '@/lib/desk/approval-packet';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { explainRefusal } from '@/lib/desk/refusal-copy';

/**
 * Run an approved archive of one closed customer record (J-ops-console-04 #10) against identity, as the signed-in founder.
 *
 * Identity spends the approval once, in the same transaction that archives the record, and refuses without it
 * (`identity.archive_requires_approver`) or while the account is open (`identity.archive_blocked_open_account`), before the
 * approval is spent. Each run takes a new request id, for the reason given in `restore.ts`: identity replays a stored
 * refusal per request id, and single use comes from the approval.
 */

type ArchiveRequest = Extract<DeskRequest, { kind: 'identity.account.archive' }>;

/** What identity answered, as the desk shows it. Only an archived record counts as done. */
export function archiveReply(request: ArchiveRequest, result: AccountArchiveResult): ExecuteReply {
  if (result.userId !== request.userId || result.reasonCode !== request.reasonCode)
    return { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };
  if (result.outcome === 'changed')
    return {
      ok: true,
      detail: `Identity archived ${request.userId} at version ${result.after.version}, approved by ${result.approverUserId.slice(0, 8)}. The record is read-only from now on.`,
    };
  return { ok: false, refusal: explainRefusal(result.code, 409, false) };
}

export function archiveExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'identity.account.archive') return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const result = await founderCall(
      ctx,
      'identity',
      'accountControls.archive',
      'POST',
      {
        requestId: randomUUID(),
        userId: request.userId,
        reasonCode: request.reasonCode,
        reason: request.reason,
        expectedVersion: request.version,
        approvalId: ids.approvalId,
      },
      parseWith(accountArchiveResultSchema),
    );
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    return archiveReply(request, result.data);
  };
}
