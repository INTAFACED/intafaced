import 'server-only';
import { z } from 'zod';
import { actionApprovalPolicyEntrySchema, approvalPolicySetResultSchema, type ActionApprovalPolicyEntry } from '@intafaced/contracts';
import { staffEntrySchema, staffListSchema, type StaffEntry } from '@intafaced/contracts/identity-staff';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { payloadHashFor } from '@/lib/desk/approval-hash';
import { partFrom, type Part } from '@/lib/desk/part';
import { codeInText, explainRefusal, isKnownCode } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';

/**
 * The console's side of the staff directory and the approval policy rows (J-ops-console-09 #1, #2). Reads are the
 * signed-in founder's; each change runs only after a second founder approved the exact request, and svc-identity spends
 * that approval once. What a run reports done is what svc-identity's answer shows, never the request.
 */

const forbidden = 'svc-identity did not accept your founder session for this read. It needs a live founder signed in with a second factor.';

export interface PolicyRowsView {
  readonly asOf: string;
  readonly policies: Part<readonly ActionApprovalPolicyEntry[]>;
}

export async function loadPolicyRows(ctx: FounderCallContext): Promise<PolicyRowsView> {
  const result = await founderCall(
    ctx,
    'identity',
    'approvalPolicy.rows',
    'GET',
    undefined,
    parseWith(z.object({ policies: z.array(actionApprovalPolicyEntrySchema) })),
  );
  return { asOf: new Date().toISOString(), policies: partFrom(result, (d) => d.policies, { service: 'svc-identity', forbiddenMessage: forbidden }) };
}

export interface StaffView {
  readonly asOf: string;
  readonly staff: Part<readonly StaffEntry[]>;
}

export async function loadStaff(ctx: FounderCallContext): Promise<StaffView> {
  const result = await founderCall(ctx, 'identity', 'staff.list', 'GET', undefined, parseWith(staffListSchema));
  return { asOf: new Date().toISOString(), staff: partFrom(result, (d) => d.staff, { service: 'svc-identity', forbiddenMessage: forbidden }) };
}

const WRONG_STATE: ExecuteReply = { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };

function refusedReply(refusal: { code: string | null; message: string; status: number }): ExecuteReply {
  // Identity sends the typed code as the whole message (`action_approval.payload_mismatch`), not in brackets.
  const fromMessage = /^[a-z_]+\.[a-z_.]+$/.test(refusal.message) ? refusal.message : null;
  const code = refusal.code ?? fromMessage ?? codeInText(refusal.message);
  const view = explainRefusal(isKnownCode(code) ? code : null, refusal.status, false);
  // The typed code is always named, even when the console has no words of its own for it.
  return { ok: false, refusal: { ...view, code: code ?? view.code } };
}

/** Run an approved row change. The row identity answers with must be the one asked for. */
export function policySetExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'identity.approval_policy.set') return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const result = await founderCall(
      ctx,
      'identity',
      'approvalPolicy.set',
      'POST',
      {
        actionType: request.actionType,
        requiredApprovals: request.requiredApprovals,
        approverAudience: request.approverAudience,
        applier: request.applier,
        maxAgeSeconds: request.maxAgeSeconds,
        expectedVersion: request.expectedVersion,
        ...ids,
      },
      parseWith(approvalPolicySetResultSchema),
    );
    if (result.kind === 'refused') return refusedReply(result.refusal);
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    const entry = result.data.entry;
    if (entry.actionType !== request.actionType || entry.source !== 'console') return WRONG_STATE;
    return {
      ok: true,
      detail:
        entry.state === 'set'
          ? `svc-identity answered: ${entry.actionType} now needs ${entry.policy.requiredApprovals} approver(s) other than the requester, from ${entry.policy.approverAudience}, applied by ${entry.policy.applier}, within ${entry.policy.maxAgeSeconds} s.`
          : `svc-identity answered: the row for ${entry.actionType} is unset (${entry.code}). Nothing of this type can be asked, approved or applied until a whole row is set.`,
    };
  };
}

/** Run an approved invite. The staff record identity answers with must be for the person approved. */
export function staffInviteExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'identity.staff.invite') return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    const result = await founderCall(
      ctx,
      'identity',
      'staff.invite',
      'POST',
      {
        requestId: request.requestId,
        email: request.email,
        displayName: request.displayName,
        roleIds: [],
        approval: { approvalId: ids.approvalId, operationId: ids.operationId, payloadHash: payloadHashFor(request) },
      },
      parseWith(z.object({ staff: staffEntrySchema, mailed: z.boolean(), approverId: z.string(), auditId: z.string() })),
    );
    if (result.kind === 'refused') return refusedReply(result.refusal);
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    const { staff, mailed } = result.data;
    if (staff.email !== request.email) return WRONG_STATE;
    return {
      ok: true,
      detail: `svc-identity answered: ${staff.displayName} (${staff.email}) is invited. ${
        mailed
          ? 'Their one-time link was handed to the mail service; they set their own password at first connection.'
          : 'The mail service did not take their link (vendor.email is not connected here), so they cannot connect yet.'
      }`,
    };
  };
}
