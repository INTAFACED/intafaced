import type { Sql } from 'postgres';
import { ActionApprovalService } from '../auth/action-approval-service.js';
import type { FounderDirectory } from '../auth/action-approval-audience.js';
import { SqlActionApprovalStore } from '../auth/action-approval-store.js';
import { IDENTITY_TIER_MOVE_ACTION_TYPE } from '../auth/action-approval-audience.js';
import { identityTierPayloadHash } from './founder-controls.js';

/**
 * A stored, approved `identity.account_tier_move` row, made through identity's own approval service: `requesterId`
 * proposes over the account, version, tier and reason, and `approverId` approves the same payload. Returns its id, for a
 * tier move's `approvalId`. The type is founder-only, so the service checks both people against `founders` at approve,
 * as identity's own approval service does with the live founder entitlement.
 */
export async function approvedTierMove(
  sql: Sql,
  founders: FounderDirectory,
  input: { requesterId: string; approverId: string; userId: string; tierId: string; reason: string; expectedVersion: string },
): Promise<string> {
  const approvals = new ActionApprovalService(new SqlActionApprovalStore(sql), { ttlSeconds: 600, founders });
  const payloadHash = identityTierPayloadHash(input);
  const pending = await approvals.propose(input.requesterId, {
    actionType: IDENTITY_TIER_MOVE_ACTION_TYPE,
    targetService: 'svc-identity',
    targetId: input.userId,
    expectedVersion: input.expectedVersion,
    payloadHash,
    policyVersion: 'v1',
  });
  return (await approvals.approve(input.approverId, pending.approvalId, payloadHash)).approvalId;
}
