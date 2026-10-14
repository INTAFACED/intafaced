/**
 * Redeem a one-time recovery code to revoke all API keys.
 * Refuse if the code is spent or missing. Reuses revokeAllApiKeys.
 * Not a redo of redeem-to-revoke-other-sessions.
 * Spends the code through `redeemRecoveryCode` (recovery-redeem.ts): the `mfa` attempt is
 * reserved first, the code is claimed under `SELECT ... FOR UPDATE`, so it can never be
 * used twice, and a success clears the counter.
 */
import type { Sql } from 'postgres';
import { revokeAllApiKeys } from './revoke-all-api-keys.js';
import { assertOwnLiveSession, redeemRecoveryCode, type RecoveryRedeemCode } from './recovery-redeem.js';

export class RedeemRecoveryRevokeKeysError extends Error {
  constructor(
    message: string,
    readonly code: RecoveryRedeemCode,
  ) {
    super(message);
    this.name = 'RedeemRecoveryRevokeKeysError';
  }
}

const make = (message: string, code: RecoveryRedeemCode) => new RedeemRecoveryRevokeKeysError(message, code);

export function recoveryCodeRevokesAllKeys(code: unknown): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    throw make('Recovery code missing', 'auth.recovery_missing');
  }
}

export async function revokeAllApiKeysAfterRecoveryCode(
  sql: Sql,
  input: { userId: string; code: string },
): Promise<{ userId: string; revoked: number }> {
  recoveryCodeRevokesAllKeys(input.code);
  return redeemRecoveryCode(sql, { userId: input.userId, code: input.code, make }, () => revokeAllApiKeys(sql, input.userId, input.userId));
}
