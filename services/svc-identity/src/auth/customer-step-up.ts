/**
 * Customer step-up ceremony.
 *
 * begin records the payment (scope, purpose, amount, target) and returns a
 * passkey challenge or accepts a six-digit authenticator code. complete proves
 * that fresh factor and mints one stepUpApprovalId. A refresh token is not a
 * factor: the caller must already hold a live access token, and complete still
 * checks the code or the passkey.
 *
 * Expiry. The unanswered challenge lives 120 seconds: long enough to tap a
 * passkey or type a code that is itself only valid for about 90 seconds, short
 * enough that a begun payment does not sit on a shared screen. The approval
 * then lives 300 seconds, the same lifetime as `auth.stepUp` and the existing
 * same-person approval (SAME_PERSON_APPROVAL_TTL_SECONDS). That is the window
 * in which the client submits the bank call and may retry a timeout. One tap
 * still buys one operation, because consume is compare-and-swap.
 *
 * Rate. Opening the sheet is capped at 8 begins per user per 10 minutes, so a
 * stolen session cannot fill the table. Guessing the code uses the existing
 * per-account MFA lockout (5 failures in 10 minutes, then 15 minutes locked).
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  CUSTOMER_STEP_UP_CHALLENGE_TTL_SECONDS,
  SAME_PERSON_APPROVAL_TTL_SECONDS,
  bindCustomerStepUp,
  samePersonTargetService,
  type CustomerStepUpBeginInput,
  type CustomerStepUpBindFailure,
} from '@intafaced/contracts';
import { newApprovalIds } from './action-approval-store.js';
import { AuthError, type AuthService } from './auth-service.js';
import { SqlCustomerStepUpStore, type CustomerStepUpRow } from './customer-step-up-store.js';
import { stepUpPurposeOf } from './passkey-purposes.js';
import { generateChallenge, type AuthenticationOptionsJSON, type AuthenticationResponseJSON } from './webauthn.js';

/** Begins per user inside the window. A person retrying a sheet fits; a spray does not. */
export const CUSTOMER_STEP_UP_BEGIN_MAX = 8;
/** Ten minutes, the same window as the MFA guess budget, counted separately from it. */
export const CUSTOMER_STEP_UP_BEGIN_WINDOW_SECONDS = 600;

export type StepUpErrorCode = CustomerStepUpBindFailure | 'step_up.expired' | 'step_up.not_found' | 'step_up.session_mismatch';

export class StepUpError extends Error {
  constructor(
    message: string,
    readonly code: StepUpErrorCode,
  ) {
    super(message);
    this.name = 'StepUpError';
  }
}

const STEP_UP_COPY: Readonly<Record<StepUpErrorCode, string>> = {
  'step_up.unknown_scope': 'That confirmation is not for a payment this app can approve.',
  'step_up.purpose': 'The confirmation does not match that payment.',
  'step_up.amount': 'The amount does not match the confirmation.',
  'step_up.target': 'The recipient does not match the confirmation.',
  'step_up.fields': 'The confirmation details are incomplete.',
  'step_up.expired': 'This confirmation timed out. Start again.',
  'step_up.not_found': 'This confirmation is no longer valid. Start again.',
  'step_up.session_mismatch': 'This confirmation was started in another session. Start again.',
};

export type StepUpBeginResult = {
  readonly challengeId: string;
  readonly expiresAt: string;
  readonly scope: string;
  readonly purpose: string;
  readonly amount: string | null;
  readonly target: string | null;
  readonly totp: boolean;
  readonly webauthn: AuthenticationOptionsJSON | null;
};

export type StepUpCompleteResult = {
  readonly stepUpApprovalId: string;
  readonly expiresAt: string;
  readonly scope: string;
  readonly purpose: string;
  readonly amount: string | null;
  readonly target: string | null;
};

function refuse(code: StepUpErrorCode): never {
  throw new StepUpError(`${STEP_UP_COPY[code]} [${code}]`, code);
}

export class CustomerStepUpService {
  constructor(
    private readonly sql: Sql,
    private readonly store: SqlCustomerStepUpStore,
    private readonly auth: AuthService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async begin(
    principal: { readonly userId: string; readonly sessionId: string },
    input: CustomerStepUpBeginInput,
  ): Promise<StepUpBeginResult> {
    const bound = bindCustomerStepUp(principal.userId, input);
    if (!bound.ok) refuse(bound.code);
    const material = await this.auth.customerStepUpMaterial(principal.userId, stepUpPurposeOf(bound.scope));
    const now = this.clock();
    const challengeId = randomUUID();
    const webauthnChallenge = material.credentials.length > 0 ? generateChallenge() : null;
    const row: CustomerStepUpRow = {
      challengeId,
      userId: principal.userId,
      sessionId: principal.sessionId,
      scope: bound.scope,
      purpose: bound.purpose,
      amount: bound.amount,
      target: bound.target,
      payloadHash: bound.payloadHash,
      webauthnChallenge,
      status: 'pending',
      approvalId: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + CUSTOMER_STEP_UP_CHALLENGE_TTL_SECONDS * 1000),
      mintedAt: null,
    };

    await transaction(
      this.sql,
      async (tx) => {
        const locked = await tx<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${principal.userId} LIMIT 1 FOR UPDATE`;
        if (!locked[0]) throw new AuthError('User not found', 'auth.not_found');
        const since = new Date(now.getTime() - CUSTOMER_STEP_UP_BEGIN_WINDOW_SECONDS * 1000);
        const recent = await this.store.countSince(principal.userId, since, tx);
        if (recent.count >= CUSTOMER_STEP_UP_BEGIN_MAX) {
          const oldest = recent.oldest?.getTime() ?? now.getTime();
          const retryAfterSeconds = Math.max(1, Math.ceil((oldest + CUSTOMER_STEP_UP_BEGIN_WINDOW_SECONDS * 1000 - now.getTime()) / 1000));
          throw new AuthError('Too many confirmation attempts. Try again later.', 'auth.too_many_attempts', { retryAfterSeconds });
        }
        await this.store.insert(row, tx);
      },
      { isolation: 'read committed', maxAttempts: 1 },
    );

    const webauthn = webauthnChallenge === null ? null : this.auth.passkeyOptions(material.credentials, webauthnChallenge);
    return {
      challengeId,
      expiresAt: row.expiresAt.toISOString(),
      scope: row.scope,
      purpose: row.purpose,
      amount: row.amount,
      target: row.target,
      totp: material.totp,
      webauthn,
    };
  }

  async complete(
    principal: { readonly userId: string; readonly sessionId: string },
    input: { readonly challengeId: string; readonly totpCode?: string; readonly webauthn?: AuthenticationResponseJSON },
  ): Promise<StepUpCompleteResult> {
    const preview = await this.preview(input.challengeId, principal);
    if (input.webauthn && !preview.webauthnChallenge) {
      throw new AuthError('Invalid two-factor assertion', 'auth.webauthn_invalid');
    }
    await this.auth.proveFreshFactor({
      userId: principal.userId,
      sessionId: principal.sessionId,
      purpose: stepUpPurposeOf(preview.scope),
      ...(input.totpCode ? { totpCode: input.totpCode } : {}),
      ...(input.webauthn && preview.webauthnChallenge ? { webauthn: input.webauthn, webauthnChallenge: preview.webauthnChallenge } : {}),
    });

    const now = this.clock();
    const approvalId = newApprovalIds().approvalId;
    const expiresAt = new Date(now.getTime() + SAME_PERSON_APPROVAL_TTL_SECONDS * 1000);
    const minted = await transaction(
      this.sql,
      async (tx) => {
        const row = await this.store.lock(input.challengeId, tx);
        if (!row || row.userId !== principal.userId) refuse('step_up.not_found');
        if (row.sessionId !== principal.sessionId) refuse('step_up.session_mismatch');
        if (row.status !== 'pending') refuse('step_up.not_found');
        if (row.expiresAt.getTime() <= now.getTime()) {
          await this.store.markExpired(row.challengeId, tx);
          refuse('step_up.expired');
        }
        await tx`
          INSERT INTO action_approvals (
            approval_id, action_type, target_service, target_id, expected_version, payload_hash,
            requester_id, approver_id, policy_version, operation_id, status, created_at, expires_at, approved_at, consumed_at,
            kind, session_id
          ) VALUES (
            ${approvalId}, ${row.scope}, ${samePersonTargetService(row.scope)}, ${row.scope}, ${'1'}, ${row.payloadHash},
            ${row.userId}, ${row.userId}, ${'step-up-v1'}, ${approvalId}, ${'APPROVED'},
            ${now}, ${expiresAt}, ${now}, ${null}, ${'same_person'}, ${row.sessionId}
          )
        `;
        const marked = await this.store.markMinted(row.challengeId, approvalId, now, tx);
        if (!marked) refuse('step_up.not_found');
        await this.store.audit(
          {
            event: 'minted',
            challengeId: row.challengeId,
            approvalId,
            userId: row.userId,
            sessionId: row.sessionId,
            scope: row.scope,
            purpose: row.purpose,
            amount: row.amount,
            target: row.target,
            createdAt: now,
          },
          tx,
        );
        return row;
      },
      { isolation: 'read committed', maxAttempts: 1 },
    );

    return {
      stepUpApprovalId: approvalId,
      expiresAt: expiresAt.toISOString(),
      scope: minted.scope,
      purpose: minted.purpose,
      amount: minted.amount,
      target: minted.target,
    };
  }

  /** Read the pending row before the factor check so a mismatch does not burn a code. */
  private async preview(
    challengeId: string,
    principal: { readonly userId: string; readonly sessionId: string },
  ): Promise<CustomerStepUpRow> {
    const rows = await this.sql<
      Array<{
        challenge_id: string;
        user_id: string;
        session_id: string;
        status: string;
        expires_at: Date;
        webauthn_challenge: string | null;
        scope: string;
        purpose: string;
        amount: string | null;
        target: string | null;
        payload_hash: string;
        created_at: Date;
      }>
    >`
      SELECT challenge_id, user_id, session_id, status, expires_at, webauthn_challenge, scope, purpose, amount, target, payload_hash, created_at
      FROM customer_step_ups WHERE challenge_id = ${challengeId} LIMIT 1
    `;
    const row = rows[0];
    if (!row || row.user_id !== principal.userId) refuse('step_up.not_found');
    if (row.session_id !== principal.sessionId) refuse('step_up.session_mismatch');
    const now = this.clock();
    const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
    if (row.status !== 'pending' || expiresAt.getTime() <= now.getTime()) {
      if (row.status === 'pending' && expiresAt.getTime() <= now.getTime()) {
        await this.store.markExpired(row.challenge_id);
      }
      refuse(row.status === 'pending' ? 'step_up.expired' : 'step_up.not_found');
    }
    return {
      challengeId: row.challenge_id,
      userId: row.user_id,
      sessionId: row.session_id,
      scope: row.scope,
      purpose: row.purpose,
      amount: row.amount,
      target: row.target,
      payloadHash: row.payload_hash,
      webauthnChallenge: row.webauthn_challenge,
      status: 'pending',
      approvalId: null,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      expiresAt,
      mintedAt: null,
    };
  }
}
