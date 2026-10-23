import type { Sql } from 'postgres';
import { ActionApprovalService } from '../auth/action-approval-service.js';
import { SqlActionApprovalStore } from '../auth/action-approval-store.js';
import { IDENTITY_UNFREEZE_ACTION_TYPE } from '../auth/action-approval-audience.js';
import { identityUnfreezePayloadHash } from './founder-controls.js';

/**
 * A stored, approved `identity.account_unfreeze` row, made through identity's own approval service: `requesterId`
 * proposes over the account, version and reason, and `approverId` approves the same payload. Returns its id, for an
 * identity restore's `approvalId`. Who may approve is the router's audience check; this is the row a restore spends.
 */
export async function approvedUnfreeze(
  sql: Sql,
  input: { requesterId: string; approverId: string; userId: string; reason: string; expectedVersion: string },
): Promise<string> {
  const approvals = new ActionApprovalService(new SqlActionApprovalStore(sql), { ttlSeconds: 600 });
  const payloadHash = identityUnfreezePayloadHash({ userId: input.userId, reason: input.reason });
  const pending = await approvals.propose(input.requesterId, {
    actionType: IDENTITY_UNFREEZE_ACTION_TYPE,
    targetService: 'svc-identity',
    targetId: input.userId,
    expectedVersion: input.expectedVersion,
    payloadHash,
    policyVersion: 'v1',
  });
  return (await approvals.approve(input.approverId, pending.approvalId, payloadHash)).approvalId;
}
