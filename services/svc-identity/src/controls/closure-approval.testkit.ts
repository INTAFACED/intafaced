import type { Sql } from 'postgres';
import type { AccountCloseReasonCode } from '@intafaced/contracts';
import { ActionApprovalService } from '../auth/action-approval-service.js';
import { SqlActionApprovalStore } from '../auth/action-approval-store.js';
import { IDENTITY_CLOSE_ACTION_TYPE, IDENTITY_REOPEN_ACTION_TYPE } from '../auth/action-approval-audience.js';
import { identityClosurePayloadHash } from './founder-controls.js';

/**
 * A stored, approved `identity.account_close` or `identity.account_reopen` row, made through identity's own approval
 * service: `requesterId` proposes over the account, version, reason code and reason, and `approverId` approves the same
 * payload. Returns its id, for a staff closure's `approvalId`.
 */
export async function approvedClosure(
  sql: Sql,
  input: {
    requesterId: string;
    approverId: string;
    userId: string;
    action: 'close' | 'reopen';
    reasonCode?: AccountCloseReasonCode;
    reason: string;
    expectedVersion: string;
  },
): Promise<string> {
  const approvals = new ActionApprovalService(new SqlActionApprovalStore(sql), { ttlSeconds: 600 });
  const payloadHash = identityClosurePayloadHash(input);
  const pending = await approvals.propose(input.requesterId, {
    actionType: input.action === 'close' ? IDENTITY_CLOSE_ACTION_TYPE : IDENTITY_REOPEN_ACTION_TYPE,
    targetService: 'svc-identity',
    targetId: input.userId,
    expectedVersion: input.expectedVersion,
    payloadHash,
    policyVersion: 'v1',
  });
  return (await approvals.approve(input.approverId, pending.approvalId, payloadHash)).approvalId;
}
