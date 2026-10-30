import 'server-only';
import { actionApprovalPoliciesReadSchema, type ActionApprovalPolicyEntry } from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';

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
  const result = await founderCall(ctx, 'identity', 'actionApproval.policies', 'GET', undefined, parseWith(actionApprovalPoliciesReadSchema));
  return { asOf: new Date().toISOString(), policies: partFrom(result, (d) => d.policies, labels) };
}
