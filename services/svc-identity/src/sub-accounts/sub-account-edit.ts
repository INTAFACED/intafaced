/**
 * Edit the label and purpose of one of the caller's own sub-accounts (RC-identity-14, TRD-0707).
 * Display fields only: the row id (the ledger owner id) is never touched, no money moves, and freeze is separate.
 * Session only, parent only, step-up `identity.step_up.sub_account_edit` (the spec's `subaccount_edit`, named like `sub_account_delete`).
 * The step-up is spent inside the transaction, after the row lock and the same-value check. Every change writes an audit row with the
 * old and new text in the same transaction; a repeat with the same values answers `changed: false` and spends nothing.
 */
import { customerStepUpPayloadHash } from '@intafaced/contracts';
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ActionApprovalError } from '../auth/action-approval-service.js';
import { transaction } from '@intafaced/db';
import { userCopy } from '../user-copy.js';

export const SUB_ACCOUNT_EDIT_SCOPE = 'identity.step_up.sub_account_edit';
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// The limits `subAccounts.create` already uses, plus no control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export type SubAccountEditCode =
  | 'identity.sub_account_edit_delegated'
  | 'auth.not_found'
  | 'identity.sub_account_revoked'
  | 'identity.sub_account_label_invalid'
  | 'identity.client_request_id_invalid'
  | 'identity.sub_account_edit_unavailable'
  | 'identity.step_up_required'
  | 'identity.step_up_expired'
  | 'identity.step_up_used'
  | 'identity.step_up_not_yours'
  | 'identity.step_up_target';

export class SubAccountEditError extends Error {
  constructor(readonly code: SubAccountEditCode) {
    super(userCopy(code));
    this.name = 'SubAccountEditError';
  }
}

export type SubAccountEditDeps = {
  sql: Sql;
  approvals: { consume(callerService: string, input: ActionApprovalConsumeInput): Promise<unknown> };
};

export type SubAccountEditInput = {
  userId: string;
  sessionId: string;
  apiKey: boolean;
  subAccount: boolean;
  subAccountId: string;
  /** Always sent, so the step-up is minted over exactly the text that is saved. */
  label: string;
  /** Always sent; null or empty clears it. */
  purpose: string | null;
  stepUpApprovalId: string;
  clientRequestId: string;
};

export function validSubAccountLabel(label: string, purpose: string | null): boolean {
  if (label.length < 1 || label.length > 64 || CONTROL.test(label) || label.trim().length === 0) return false;
  if (purpose !== null && (purpose.length > 200 || CONTROL.test(purpose))) return false;
  return true;
}

export class SubAccountEditService {
  constructor(private readonly deps: SubAccountEditDeps) {}

  async update(input: SubAccountEditInput): Promise<{ id: string; changed: boolean }> {
    if (input.apiKey || input.subAccount) throw new SubAccountEditError('identity.sub_account_edit_delegated');
    if (!CLIENT_ID.test(input.clientRequestId)) throw new SubAccountEditError('identity.client_request_id_invalid');
    const next = { label: input.label, purpose: input.purpose === '' ? null : input.purpose };
    if (!validSubAccountLabel(next.label, next.purpose)) throw new SubAccountEditError('identity.sub_account_label_invalid');
    return transaction(this.deps.sql, async (tx) => {
      // Row lock: concurrent edits run one after the other, last writer wins, one audit row each.
      const locked = await this.owned(tx, input.userId, input.subAccountId);
      // Same values again: the same answer, no step-up spent, no audit row.
      if (locked.label === next.label && locked.purpose === next.purpose) return { id: input.subAccountId, changed: false };
      await this.consume(input, next);
      await tx`UPDATE sub_accounts SET label = ${next.label}, purpose = ${next.purpose} WHERE id = ${input.subAccountId} AND parent_user_id = ${input.userId}`;
      await tx`
        INSERT INTO sub_account_label_audit (sub_account_id, user_id, session_id, old_label, new_label, old_purpose, new_purpose)
        VALUES (${input.subAccountId}, ${input.userId}, ${input.sessionId}, ${locked.label}, ${next.label}, ${locked.purpose}, ${next.purpose})
      `;
      return { id: input.subAccountId, changed: true };
    });
  }

  private async owned(q: Sql, userId: string, subAccountId: string): Promise<{ label: string; purpose: string | null }> {
    const rows = await q<Array<{ label: string; purpose: string | null; revoked: boolean }>>`
      SELECT label, purpose, revoked FROM sub_accounts WHERE id = ${subAccountId} AND parent_user_id = ${userId} LIMIT 1 FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new SubAccountEditError('auth.not_found');
    if (row.revoked) throw new SubAccountEditError('identity.sub_account_revoked');
    return { label: row.label, purpose: row.purpose };
  }

  private async consume(input: SubAccountEditInput, next: { label: string; purpose: string | null }): Promise<void> {
    try {
      await this.deps.approvals.consume('svc-identity', {
        approvalId: input.stepUpApprovalId,
        operationId: input.stepUpApprovalId,
        payloadHash: customerStepUpPayloadHash(SUB_ACCOUNT_EDIT_SCOPE, {
          actor: input.userId,
          subAccountId: input.subAccountId,
          label: next.label,
          purpose: next.purpose ?? '',
          clientRequestId: input.clientRequestId,
        }),
        targetService: 'svc-identity',
        targetId: SUB_ACCOUNT_EDIT_SCOPE,
        expectedVersion: '1',
        principalUserId: input.userId,
        principalSessionId: input.sessionId,
      });
    } catch (err) {
      if (err instanceof ActionApprovalError) {
        const code =
          err.code === 'action_approval.expired'
            ? 'identity.step_up_expired'
            : err.code === 'action_approval.consumed'
              ? 'identity.step_up_used'
              : err.code === 'action_approval.not_requester'
                ? 'identity.step_up_not_yours'
                : err.code === 'action_approval.payload_mismatch' || err.code === 'action_approval.target_mismatch'
                  ? 'identity.step_up_target'
                  : 'identity.step_up_required';
        throw new SubAccountEditError(code);
      }
      throw err;
    }
  }
}
