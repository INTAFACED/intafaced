/**
 * Redeem a one-time recovery code against a live session of the same user.
 * Refuse if the code is missing, spent, or wrong. The session must be live and owned by `userId`.
 * Returns the existing session; it does not create or upgrade one (sign-in with a recovery code is
 * `auth.login` / `auth.stepUp`). No invented challenge. No invented session.
 * Spends the code through `redeemRecoveryCode` (recovery-redeem.ts): the `mfa` attempt is
 * reserved first, the code is claimed under `SELECT ... FOR UPDATE`, so it can never be
 * used twice, and a success clears the counter.
 */
import type { Sql } from 'postgres';
import { assertOwnLiveSession, redeemRecoveryCode, type RecoveryRedeemCode } from './recovery-redeem.js';

export class RedeemRecoverySessionError extends Error {
  constructor(
    message: string,
    readonly code: RecoveryRedeemCode,
  ) {
    super(message);
    this.name = 'RedeemRecoverySessionError';
  }
}

const make = (message: string, code: RecoveryRedeemCode) => new RedeemRecoverySessionError(message, code);

export function recoveryCodeOpensSession(code: unknown): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    throw make('Recovery code missing', 'auth.recovery_missing');
  }
}

export async function openLiveSessionAfterRecoveryCode(
  sql: Sql,
  input: { userId: string; sessionId: string; code: string },
): Promise<{ id: string; userId: string }> {
  recoveryCodeOpensSession(input.code);
  const live = await assertOwnLiveSession(sql, input.userId, input.sessionId);
  return redeemRecoveryCode(sql, { userId: input.userId, code: input.code, make }, async () => live);
}
