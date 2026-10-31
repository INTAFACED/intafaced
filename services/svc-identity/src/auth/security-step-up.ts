/**
 * One guard for every security change on the caller's own sign-in methods and limits (ENGINE STP-3).
 *
 * A procedure that changes a passkey, the authenticator, recovery codes, the password, the fund
 * password, a limit, a freeze, a trusted device or a linked sign-in method calls `require` first. The
 * guard refuses an API key or a sub-account, refuses an account with no second factor (so the client
 * can offer enrolment), asks for a step-up when none is presented, and otherwise spends the approval:
 * once, for this person and session, for exactly this action and these field values.
 *
 * The approval is minted by `customerStepUp.begin/complete` (customer-step-up.ts); this file adds no
 * second table. The approval is gone once spent, so the guarded call must be idempotent on its own
 * business key; a retry then needs a new approval and returns the stored result.
 */
import { bindCustomerStepUp, doorForScope, type ActionApprovalConsumeInput, type SamePersonActionType } from '@intafaced/contracts';
import { TRPCError } from '@trpc/server';
import type { Sql } from 'postgres';
import { userCopy } from '../user-copy.js';
import { ActionApprovalError } from './action-approval-service.js';
import { AuthError } from './auth-service.js';

/**
 * The 13 security scopes of ENGINE STP-3, binding passkeys to purposes and the passkey second step (I-signin-sessions-10), the security lock's unlock request (W-withdraw-09), recovery keys (RC-identity-07) and approving a new device
 * from a trusted session (I-signin-sessions-07). Close account, contact
 * changes and payments have their own guards.
 */
export const SECURITY_STEP_UP_SCOPES = [
  'identity.step_up.passkey_add',
  'identity.step_up.passkey_remove',
  'identity.step_up.passkey_rename',
  'identity.step_up.passkey_purposes',
  'identity.step_up.passkey_second_step',
  'identity.step_up.totp_replace',
  'identity.step_up.totp_disable',
  'identity.step_up.recovery_codes_regenerate',
  'identity.step_up.password_change_with_second_factor',
  'identity.step_up.fund_password_set',
  'identity.step_up.limits_loosen',
  'identity.step_up.self_freeze_lift',
  'identity.step_up.trusted_device_remove',
  'identity.step_up.trusted_device_approve',
  'identity.step_up.link_method',
  'identity.step_up.unlink_method',
  'identity.step_up.security_lock_unlock',
  'identity.step_up.recovery_key_change',
] as const satisfies readonly SamePersonActionType[];

export type SecurityStepUpScope = (typeof SECURITY_STEP_UP_SCOPES)[number];

export type SecurityStepUpCode =
  | 'identity.step_up_required'
  | 'identity.second_factor_required'
  | 'identity.step_up_expired'
  | 'identity.step_up_used'
  | 'identity.step_up_not_yours'
  | 'identity.step_up_target'
  | 'identity.delegated_refused';

export class SecurityStepUpError extends Error {
  constructor(
    readonly code: SecurityStepUpCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'SecurityStepUpError';
  }
}

export type SecurityStepUpPrincipal = {
  readonly userId: string;
  readonly sid: string;
  readonly kid?: string | null | undefined;
  readonly sub_account?: string | null | undefined;
};

export type SecurityStepUpDeps = {
  readonly sql: Sql;
  readonly approvals: { consume(callerService: string, input: ActionApprovalConsumeInput): Promise<unknown> };
  /** Throws `auth.mfa_not_enrolled` when the account has neither a passkey nor an authenticator. */
  readonly secondFactor: (userId: string) => Promise<unknown>;
  /** The approvals' own clock, so `assertHeld` reads expiry as `consume` does. Defaults to the system clock. */
  readonly now?: () => Date;
};

export class SecurityStepUp {
  constructor(private readonly deps: SecurityStepUpDeps) {}

  /**
   * Resolves when the change may run. Throws `SecurityStepUpError` otherwise; `fields` are the call's own
   * values, the same keys the scope's door lists (for example `credentialId`, `clientRequestId`).
   */
  async require(
    principal: SecurityStepUpPrincipal,
    scope: SecurityStepUpScope,
    fields: Readonly<Record<string, string>>,
    stepUpApprovalId?: string | null,
  ): Promise<void> {
    if (principal.kid || principal.sub_account) throw new SecurityStepUpError('identity.delegated_refused');
    const door = doorForScope(scope);
    if (!door || !(SECURITY_STEP_UP_SCOPES as readonly string[]).includes(scope)) {
      throw new TypeError(`${scope} is not a security step-up scope`);
    }
    const bound = bindCustomerStepUp(principal.userId, {
      scope,
      purpose: door.purpose,
      ...(door.amountField ? { amount: fields[door.amountField] ?? '' } : {}),
      ...(door.targetField ? { target: fields[door.targetField] ?? '' } : {}),
      fields,
    });
    if (!bound.ok) throw new SecurityStepUpError('identity.step_up_target');

    try {
      await this.deps.secondFactor(principal.userId);
    } catch (err) {
      if (err instanceof AuthError && err.code === 'auth.mfa_not_enrolled') {
        throw new SecurityStepUpError('identity.second_factor_required');
      }
      throw err;
    }
    if (!stepUpApprovalId) throw new SecurityStepUpError('identity.step_up_required');

    try {
      await this.deps.approvals.consume('svc-identity', {
        approvalId: stepUpApprovalId,
        operationId: stepUpApprovalId,
        payloadHash: bound.payloadHash,
        targetService: 'svc-identity',
        targetId: scope,
        expectedVersion: '1',
        principalUserId: principal.userId,
        principalSessionId: principal.sid,
      });
    } catch (err) {
      if (!(err instanceof ActionApprovalError)) throw err;
      throw new SecurityStepUpError(await this.codeFor(err, stepUpApprovalId, principal.userId));
    }
  }

  /**
   * Resolves when `stepUpApprovalId` is this session's approved, unspent and unexpired step-up for exactly these values,
   * without spending it. A first phase (starting an authenticator replace) checks the approval its second phase then
   * consumes through `require`, so one confirmation covers both and neither can run without it. Throws
   * `SecurityStepUpError` otherwise.
   */
  async assertHeld(
    principal: SecurityStepUpPrincipal,
    scope: SecurityStepUpScope,
    fields: Readonly<Record<string, string>>,
    stepUpApprovalId?: string | null,
  ): Promise<void> {
    if (principal.kid || principal.sub_account) throw new SecurityStepUpError('identity.delegated_refused');
    const door = doorForScope(scope);
    if (!door || !(SECURITY_STEP_UP_SCOPES as readonly string[]).includes(scope)) {
      throw new TypeError(`${scope} is not a security step-up scope`);
    }
    const bound = bindCustomerStepUp(principal.userId, {
      scope,
      purpose: door.purpose,
      ...(door.amountField ? { amount: fields[door.amountField] ?? '' } : {}),
      ...(door.targetField ? { target: fields[door.targetField] ?? '' } : {}),
      fields,
    });
    if (!bound.ok) throw new SecurityStepUpError('identity.step_up_target');
    if (!stepUpApprovalId) throw new SecurityStepUpError('identity.step_up_required');
    const rows = await this.deps.sql<
      Array<{
        requester_id: string;
        session_id: string | null;
        payload_hash: string;
        target_service: string;
        target_id: string;
        status: string;
        consumed_at: Date | null;
        expires_at: Date;
      }>
    >`
      SELECT requester_id, session_id, payload_hash, target_service, target_id, status, consumed_at, expires_at
        FROM action_approvals WHERE approval_id = ${stepUpApprovalId}
    `;
    const row = rows[0];
    if (!row) throw new SecurityStepUpError('identity.step_up_required');
    if (row.requester_id !== principal.userId || row.session_id !== principal.sid) {
      throw new SecurityStepUpError('identity.step_up_not_yours');
    }
    if (row.consumed_at || row.status === 'CONSUMED') throw new SecurityStepUpError('identity.step_up_used');
    const now = this.deps.now?.() ?? new Date();
    if (row.expires_at.getTime() <= now.getTime() || row.status === 'EXPIRED') throw new SecurityStepUpError('identity.step_up_expired');
    if (row.status !== 'APPROVED') throw new SecurityStepUpError('identity.step_up_required');
    if (row.target_service !== 'svc-identity' || row.target_id !== scope || row.payload_hash !== bound.payloadHash) {
      throw new SecurityStepUpError('identity.step_up_target');
    }
  }

  private async codeFor(err: ActionApprovalError, approvalId: string, userId: string): Promise<SecurityStepUpCode> {
    if (err.code === 'action_approval.payload_mismatch') {
      // The payload hash includes the actor, so another person's approval misses the hash before the
      // principal check. Say it is not theirs, not that the values differ.
      const rows = await this.deps.sql<Array<{ requester_id: string }>>`
        SELECT requester_id FROM action_approvals WHERE approval_id = ${approvalId}
      `;
      if (rows[0] && rows[0].requester_id !== userId) return 'identity.step_up_not_yours';
    }
    switch (err.code) {
      case 'action_approval.expired':
        return 'identity.step_up_expired';
      case 'action_approval.consumed':
        return 'identity.step_up_used';
      case 'action_approval.not_requester':
        return 'identity.step_up_not_yours';
      case 'action_approval.payload_mismatch':
      case 'action_approval.target_mismatch':
        return 'identity.step_up_target';
      default:
        return 'identity.step_up_required';
    }
  }
}

/**
 * The wire shape every guarded procedure answers with: a client branches on `cause.code` and shows
 * the copy. The delegated refusal is FORBIDDEN; every other step-up answer is PRECONDITION_FAILED.
 */
export function toSecurityStepUpTrpc(err: unknown): never {
  if (err instanceof SecurityStepUpError) {
    throw new TRPCError({
      code: err.code === 'identity.delegated_refused' ? 'FORBIDDEN' : 'PRECONDITION_FAILED',
      message: userCopy(err.code),
      cause: err,
    });
  }
  throw err;
}
