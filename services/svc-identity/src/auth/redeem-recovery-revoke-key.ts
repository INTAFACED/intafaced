/**
 * Revoke an API key only from the recovered session after a recovery redeem.
 * Refuse if the code is spent or missing. The session must be live and owned by `userId`.
 * Not a redo of revoke-all-keys or recovery-rotate.
 * Spends the code through `redeemRecoveryCode` (recovery-redeem.ts): the `mfa` attempt is
 * reserved first, the code is claimed under `SELECT ... FOR UPDATE`, so it can never be
 * used twice, and a success clears the counter.
 */
import type { Sql } from 'postgres';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { assertOwnLiveApiKey, assertOwnLiveSession, redeemRecoveryCode, type RecoveryRedeemCode } from './recovery-redeem.js';

export class RedeemRecoveryRevokeKeyError extends Error {
  constructor(
    message: string,
    readonly code: RecoveryRedeemCode,
  ) {
    super(message);
    this.name = 'RedeemRecoveryRevokeKeyError';
  }
}

const make = (message: string, code: RecoveryRedeemCode) => new RedeemRecoveryRevokeKeyError(message, code);

export function recoveryCodeRevokesApiKey(code: unknown): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    throw make('Recovery code missing', 'auth.recovery_missing');
  }
}

export async function revokeApiKeyAfterRecoveryCode(
  minter: ApiKeyMinter,
  sql: Sql,
  input: { userId: string; sessionId: string; keyId: string; code: string },
): Promise<{ revokedKeyId: string; sessionId: string }> {
  recoveryCodeRevokesApiKey(input.code);
  const live = await assertOwnLiveSession(sql, input.userId, input.sessionId);
  await assertOwnLiveApiKey(sql, input.userId, input.keyId, make);
  return redeemRecoveryCode(sql, { userId: input.userId, code: input.code, make }, async () => {
    const revoked = await minter.revokeApiKey(input.userId, input.keyId);
    if (!revoked) throw make('API key not found', 'auth.not_found');
    return { revokedKeyId: input.keyId, sessionId: live.id };
  });
}
