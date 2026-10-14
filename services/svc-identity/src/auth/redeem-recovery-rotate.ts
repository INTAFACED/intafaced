/**
 * Rotate an API key only from the recovered session after a recovery redeem.
 * The old key cannot place. Refuse if the code is spent or missing. The session must be live and
 * owned by `userId`. Reuses rotateApiKey. Not a redo of recovery-mint.
 * Spends the code through `redeemRecoveryCode` (recovery-redeem.ts): the `mfa` attempt is
 * reserved first, the code is claimed under `SELECT ... FOR UPDATE`, so it can never be
 * used twice, and a success clears the counter.
 */
import { assertDelegatableScopes } from '@intafaced/auth';
import type { Sql } from 'postgres';
import { assertDelegateCannotGrant } from './auth-service.js';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { rotateApiKey } from './rotate-api-key.js';
import { assertOwnLiveApiKey, assertOwnLiveSession, redeemRecoveryCode, type RecoveryRedeemCode } from './recovery-redeem.js';

export class RedeemRecoveryRotateError extends Error {
  constructor(
    message: string,
    readonly code: RecoveryRedeemCode,
  ) {
    super(message);
    this.name = 'RedeemRecoveryRotateError';
  }
}

const make = (message: string, code: RecoveryRedeemCode) => new RedeemRecoveryRotateError(message, code);

export function recoveryCodeRotatesApiKey(code: unknown): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    throw make('Recovery code missing', 'auth.recovery_missing');
  }
}

export async function rotateApiKeyAfterRecoveryCode(
  minter: ApiKeyMinter,
  sql: Sql,
  input: { userId: string; sessionId: string; keyId: string; code: string; grantorScopes: readonly string[]; grantorKid?: string | null },
): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox'; revokedKeyId: string; sessionId: string }> {
  recoveryCodeRotatesApiKey(input.code);
  const live = await assertOwnLiveSession(sql, input.userId, input.sessionId);
  const old = await assertOwnLiveApiKey(sql, input.userId, input.keyId, make);
  // Grantor limits are checked before the claim too, so they answer the same for any code.
  assertDelegateCannotGrant(input.grantorKid);
  assertDelegatableScopes(old.scopes, input.grantorScopes);
  return redeemRecoveryCode(sql, { userId: input.userId, code: input.code, make }, async () => {
    const rotated = await rotateApiKey(minter, sql, {
      userId: input.userId,
      keyId: input.keyId,
      grantorScopes: input.grantorScopes,
      grantorKid: input.grantorKid,
    });
    return { ...rotated, sessionId: live.id };
  });
}
