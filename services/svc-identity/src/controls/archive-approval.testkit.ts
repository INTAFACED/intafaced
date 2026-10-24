import type { Sql } from 'postgres';
import type { AccountArchiveReasonCode } from '@intafaced/contracts';
import { ActionApprovalService } from '../auth/action-approval-service.js';
import { SqlActionApprovalStore } from '../auth/action-approval-store.js';
import { IDENTITY_ARCHIVE_ACTION_TYPE, type FounderDirectory } from '../auth/action-approval-audience.js';
import { identityArchivePayloadHash } from './founder-controls.js';

/**
 * A stored, approved `identity.account_archive` row, made through identity's own approval service: `requesterId` proposes
 * over the account, version, reason code and reason, and `approverId` approves the same payload. Returns its id. The type
 * is founder-only, so the service checks both people against `founders` at approve.
 */
export async function approvedArchive(
  sql: Sql,
  founders: FounderDirectory,
  input: {
    requesterId: string;
    approverId: string;
    userId: string;
    reasonCode: AccountArchiveReasonCode;
    reason: string;
    expectedVersion: string;
  },
): Promise<string> {
  const approvals = new ActionApprovalService(new SqlActionApprovalStore(sql), { ttlSeconds: 600, founders });
  const payloadHash = identityArchivePayloadHash(input);
  const pending = await approvals.propose(input.requesterId, {
    actionType: IDENTITY_ARCHIVE_ACTION_TYPE,
    targetService: 'svc-identity',
    targetId: input.userId,
    expectedVersion: input.expectedVersion,
    payloadHash,
    policyVersion: 'v1',
  });
  return (await approvals.approve(input.approverId, pending.approvalId, payloadHash)).approvalId;
}
