/**
 * Sub-account sign-in control and switching (I-account-lifecycle-04).
 *
 * - `setSignIn`: the main account turns sign-in for one of its sub-accounts on or off. Off by default. Session only,
 *   parent only, step-up `identity.step_up.sub_account_signin` bound to (sub-account, enabled, request id). The same
 *   value again answers `changed:false` and spends nothing; each change writes an audit row in the same transaction.
 * - `switchTo`: the main session gets a short-lived access token scoped to one of its sub-accounts (`sub_account`
 *   claim). It keeps the main session. A revoked or frozen sub-account, or a frozen main account, refuses. The owner's
 *   minimum interval between switches is `SUBACCOUNT_SWITCH_MIN_SECONDS` (unset = none stated, so no wait).
 */
import { customerStepUpPayloadHash } from '@intafaced/contracts';
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { ActionApprovalError } from '../auth/action-approval-service.js';
import { userCopy } from '../user-copy.js';

export const SUB_ACCOUNT_SIGNIN_SCOPE = 'identity.step_up.sub_account_signin';
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type SubAccountSwitchCode =
  | 'identity.sub_account_switch_delegated'
  | 'auth.not_found'
  | 'identity.sub_account_revoked'
  | 'identity.sub_account_switch_frozen'
  | 'identity.sub_account_switch_too_soon'
  | 'identity.sub_account_switch_unavailable'
  | 'identity.client_request_id_invalid'
  | 'identity.step_up_required'
  | 'identity.step_up_expired'
  | 'identity.step_up_used'
  | 'identity.step_up_not_yours'
  | 'identity.step_up_target';

export class SubAccountSwitchError extends Error {
  constructor(readonly code: SubAccountSwitchCode) {
    super(userCopy(code));
    this.name = 'SubAccountSwitchError';
  }
}

export type SwitchTokenIssuer = (input: {
  userId: string;
  sessionId: string;
  subAccountId: string;
  mfa: boolean;
}) => Promise<{ accessToken: string; expiresAt: Date }>;

export type SubAccountSwitchDeps = {
  sql: Sql;
  approvals: { consume(callerService: string, input: ActionApprovalConsumeInput): Promise<unknown> };
  issue: SwitchTokenIssuer;
  /** `SUBACCOUNT_SWITCH_MIN_SECONDS`; undefined = none stated. */
  minSwitchSeconds: () => number | undefined;
  now?: () => Date;
};

type Actor = { userId: string; sessionId: string; apiKey: boolean; subAccount: boolean; mfa: boolean };
type Row = { revoked: boolean; frozen: number; signin_enabled: boolean };

export class SubAccountSwitchService {
  constructor(private readonly deps: SubAccountSwitchDeps) {}

  async setSignIn(
    input: Actor & { subAccountId: string; enabled: boolean; stepUpApprovalId: string; clientRequestId: string },
  ): Promise<{ id: string; signInEnabled: boolean; changed: boolean }> {
    this.assertSession(input);
    if (!CLIENT_ID.test(input.clientRequestId)) throw new SubAccountSwitchError('identity.client_request_id_invalid');
    return transaction(this.deps.sql, async (tx) => {
      const row = await this.owned(tx, input.userId, input.subAccountId, true);
      if (row.revoked) throw new SubAccountSwitchError('identity.sub_account_revoked');
      if (row.signin_enabled === input.enabled) return { id: input.subAccountId, signInEnabled: input.enabled, changed: false };
      await this.consume(input);
      await tx`UPDATE sub_accounts SET signin_enabled = ${input.enabled} WHERE id = ${input.subAccountId} AND parent_user_id = ${input.userId}`;
      await tx`
        INSERT INTO sub_account_signin_audit (sub_account_id, user_id, session_id, enabled)
        VALUES (${input.subAccountId}, ${input.userId}, ${input.sessionId}, ${input.enabled})`;
      return { id: input.subAccountId, signInEnabled: input.enabled, changed: true };
    });
  }

  async switchTo(input: Actor & { subAccountId: string }): Promise<{ subAccountId: string; accessToken: string; expiresAt: string }> {
    this.assertSession(input);
    const now = (this.deps.now ?? (() => new Date()))();
    const switchId = await transaction(this.deps.sql, async (tx) => {
      // Serialise one user's switches so the interval check and the record agree.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'identity.sub_account_switch:' + input.userId}))`;
      const row = await this.owned(tx, input.userId, input.subAccountId, false);
      if (row.revoked) throw new SubAccountSwitchError('identity.sub_account_revoked');
      if (row.frozen === 1) throw new SubAccountSwitchError('identity.sub_account_switch_frozen');
      const min = this.deps.minSwitchSeconds();
      if (min !== undefined && min > 0) {
        const [last] = await tx<Array<{ at: Date }>>`
          SELECT at FROM sub_account_switches WHERE user_id = ${input.userId} ORDER BY at DESC LIMIT 1`;
        if (last && now.getTime() - last.at.getTime() < min * 1000) throw new SubAccountSwitchError('identity.sub_account_switch_too_soon');
      }
      const [rec] = await tx<Array<{ id: string }>>`
        INSERT INTO sub_account_switches (user_id, sub_account_id, session_id, at)
        VALUES (${input.userId}, ${input.subAccountId}, ${input.sessionId}, ${now}) RETURNING id`;
      return rec!.id;
    });
    // The issuer re-checks the main session and account status; a frozen main account refuses there.
    let issued: Awaited<ReturnType<SwitchTokenIssuer>>;
    try {
      issued = await this.deps.issue({
        userId: input.userId,
        sessionId: input.sessionId,
        subAccountId: input.subAccountId,
        mfa: input.mfa,
      });
    } catch (err) {
      // No token was issued, so this is not a switch: drop the record so it never counts toward the owner's interval.
      await this.deps.sql`DELETE FROM sub_account_switches WHERE id = ${switchId}`;
      throw err;
    }
    return { subAccountId: input.subAccountId, accessToken: issued.accessToken, expiresAt: issued.expiresAt.toISOString() };
  }

  private assertSession(input: Actor): void {
    if (input.apiKey || input.subAccount) throw new SubAccountSwitchError('identity.sub_account_switch_delegated');
  }

  private async owned(q: Sql, userId: string, subAccountId: string, lock: boolean): Promise<Row> {
    const rows = lock
      ? await q<
          Row[]
        >`SELECT revoked, frozen, signin_enabled FROM sub_accounts WHERE id = ${subAccountId} AND parent_user_id = ${userId} LIMIT 1 FOR UPDATE`
      : await q<
          Row[]
        >`SELECT revoked, frozen, signin_enabled FROM sub_accounts WHERE id = ${subAccountId} AND parent_user_id = ${userId} LIMIT 1`;
    if (!rows[0]) throw new SubAccountSwitchError('auth.not_found');
    return rows[0];
  }

  private async consume(input: Actor & { subAccountId: string; enabled: boolean; stepUpApprovalId: string; clientRequestId: string }) {
    try {
      await this.deps.approvals.consume('svc-identity', {
        approvalId: input.stepUpApprovalId,
        operationId: input.stepUpApprovalId,
        payloadHash: customerStepUpPayloadHash(SUB_ACCOUNT_SIGNIN_SCOPE, {
          actor: input.userId,
          subAccountId: input.subAccountId,
          enabled: input.enabled ? 'true' : 'false',
          clientRequestId: input.clientRequestId,
        }),
        targetService: 'svc-identity',
        targetId: SUB_ACCOUNT_SIGNIN_SCOPE,
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
        throw new SubAccountSwitchError(code);
      }
      throw err;
    }
  }
}
