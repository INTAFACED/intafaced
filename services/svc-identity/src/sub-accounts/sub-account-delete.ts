/**
 * Delete one sub-account. Revoke-only: it moves no money. The assets and open-orders check protects funds,
 * so an unreadable money service refuses and never reads as "nothing open".
 */
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import { customerStepUpPayloadHash } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ActionApprovalError } from '../auth/action-approval-service.js';
import { userCopy } from '../user-copy.js';
import type { ClosureBalance, ClosureBlocker, ClosureCheckResult } from '../closure/closure-client.js';

export const SUB_ACCOUNT_DELETE_SCOPE = 'identity.step_up.sub_account_delete';
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type SubAccountDeleteCode =
  | 'identity.sub_account_delete_delegated'
  | 'identity.sub_account_not_found'
  | 'identity.sub_account_delete_blocked'
  | 'identity.sub_account_check_unavailable'
  | 'identity.step_up_required'
  | 'identity.step_up_expired'
  | 'identity.step_up_used'
  | 'identity.step_up_not_yours'
  | 'identity.step_up_target';

export class SubAccountDeleteError extends Error {
  constructor(
    readonly code: SubAccountDeleteCode,
    readonly blockers: readonly ClosureBlocker[] = [],
    readonly balances: readonly ClosureBalance[] = [],
  ) {
    super(userCopy(code));
    this.name = 'SubAccountDeleteError';
  }
}

export type SubAccountChecker = {
  check(input: { userId: string; subAccountIds: readonly string[]; scope?: 'account' | 'sub_accounts' }): Promise<ClosureCheckResult>;
};

export type SubAccountDeleteDeps = {
  sql: Sql;
  approvals: { consume(callerService: string, input: ActionApprovalConsumeInput): Promise<unknown> };
  bank: SubAccountChecker;
  trade: SubAccountChecker;
};

type Actor = { userId: string; sessionId: string; apiKey: boolean; subAccount: boolean };

export class SubAccountDeleteService {
  constructor(private readonly deps: SubAccountDeleteDeps) {}

  /** What still stands in the way for this one sub-account, read now. Spends no step-up and writes nothing. */
  async check(input: Actor & { subAccountId: string }): Promise<{ blockers: ClosureBlocker[]; balances: ClosureBalance[] }> {
    this.assertSession(input);
    const row = await this.owned(input.userId, input.subAccountId);
    if (row.revoked) return { blockers: [], balances: [] };
    return this.read(input.userId, input.subAccountId);
  }

  async delete(
    input: Actor & { subAccountId: string; stepUpApprovalId: string; clientRequestId: string },
  ): Promise<{ deleted: true; changed: boolean }> {
    this.assertSession(input);
    if (!CLIENT_ID.test(input.clientRequestId)) throw new SubAccountDeleteError('identity.step_up_target');
    const row = await this.owned(input.userId, input.subAccountId);
    // Already deleted: the same answer again, with no new step-up spent.
    if (row.revoked) return { deleted: true, changed: false };
    await this.consume(input);
    const found = await this.read(input.userId, input.subAccountId);
    if (found.blockers.length > 0) throw new SubAccountDeleteError('identity.sub_account_delete_blocked', found.blockers, found.balances);
    const result = await this.deps
      .sql`UPDATE sub_accounts SET revoked = true WHERE id = ${input.subAccountId} AND parent_user_id = ${input.userId} AND revoked = false`;
    return { deleted: true, changed: result.count > 0 };
  }

  private assertSession(input: Actor): void {
    if (input.apiKey || input.subAccount) throw new SubAccountDeleteError('identity.sub_account_delete_delegated');
  }

  private async owned(userId: string, subAccountId: string): Promise<{ revoked: boolean }> {
    const rows = await this.deps.sql<Array<{ revoked: boolean }>>`
      SELECT revoked FROM sub_accounts WHERE id = ${subAccountId} AND parent_user_id = ${userId} LIMIT 1
    `;
    if (!rows[0]) throw new SubAccountDeleteError('identity.sub_account_not_found');
    return rows[0];
  }

  private async read(userId: string, subAccountId: string): Promise<{ blockers: ClosureBlocker[]; balances: ClosureBalance[] }> {
    const input = { userId, subAccountIds: [subAccountId], scope: 'sub_accounts' as const };
    const [bank, trade] = await Promise.all([this.deps.bank.check(input), this.deps.trade.check(input)]);
    if (!bank.ok || !trade.ok) throw new SubAccountDeleteError('identity.sub_account_check_unavailable');
    return { blockers: [...bank.blockers, ...trade.blockers], balances: [...bank.balances] };
  }

  private async consume(input: {
    userId: string;
    sessionId: string;
    subAccountId: string;
    stepUpApprovalId: string;
    clientRequestId: string;
  }): Promise<void> {
    try {
      await this.deps.approvals.consume('svc-identity', {
        approvalId: input.stepUpApprovalId,
        operationId: input.stepUpApprovalId,
        payloadHash: customerStepUpPayloadHash(SUB_ACCOUNT_DELETE_SCOPE, {
          actor: input.userId,
          subAccountId: input.subAccountId,
          clientRequestId: input.clientRequestId,
        }),
        targetService: 'svc-identity',
        targetId: SUB_ACCOUNT_DELETE_SCOPE,
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
        throw new SubAccountDeleteError(code);
      }
      throw err;
    }
  }
}
