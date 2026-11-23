import 'server-only';
import { type ActionApprovalPolicyEntry } from '@intafaced/contracts';
import { type FounderCallContext, partFrom, type Part, founderRecordCall } from '@/lib/desk';
import { IDENTITY_ACTION_APPROVAL_POLICIES } from '@intafaced/contracts/identity-action-approval-records';

const labels = {
  service: 'svc-identity',
  forbiddenMessage: 'svc-identity did not accept this founder session for the approval policy read. It is for founders and operators.',
} as const;

export interface ChangePolicyRoom {
  readonly asOf: string;
  readonly policies: Part<readonly ActionApprovalPolicyEntry[]>;
}

/** Every governed action type with its owner policy row or `unset` (OPS-change-control-01 CR-1). Read only. */
export async function readChangePolicyRoom(ctx: FounderCallContext): Promise<ChangePolicyRoom> {
  const result = await founderRecordCall(ctx, IDENTITY_ACTION_APPROVAL_POLICIES, undefined);
  return { asOf: new Date().toISOString(), policies: partFrom(result, (d) => d.policies, labels) };
}
