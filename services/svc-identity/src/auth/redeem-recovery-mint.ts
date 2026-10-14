/**
 * Mint an API key only from the recovered session after a recovery redeem.
 * Refuse if the code is spent or missing. The session must be live and owned by `userId`.
 * Not a redo of revoke-all-keys.
 * Spends the code through `redeemRecoveryCode` (recovery-redeem.ts): the `mfa` attempt is
 * reserved first, the code is claimed under `SELECT ... FOR UPDATE`, so it can never be
 * used twice, and a success clears the counter.
 */
import type { Sql } from 'postgres';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { assertOwnLiveSession, redeemRecoveryCode, type RecoveryRedeemCode } from './recovery-redeem.js';

export class RedeemRecoveryMintError extends Error {
  constructor(
    message: string,
    readonly code: RecoveryRedeemCode,
  ) {
    super(message);
    this.name = 'RedeemRecoveryMintError';
  }
}

const make = (message: string, code: RecoveryRedeemCode) => new RedeemRecoveryMintError(message, code);

export function recoveryCodeMintsApiKey(code: unknown): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    throw make('Recovery code missing', 'auth.recovery_missing');
  }
}

export async function mintApiKeyAfterRecoveryCode(
  minter: ApiKeyMinter,
  sql: Sql,
  input: {
    userId: string;
    sessionId: string;
    code: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
    grantorKid?: string | null;
    domainWhitelist?: string[];
    expiresAt?: Date;
    mode?: 'live' | 'sandbox';
  },
): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox'; sessionId: string }> {
  recoveryCodeMintsApiKey(input.code);
  const live = await assertOwnLiveSession(sql, input.userId, input.sessionId);
  return redeemRecoveryCode(sql, { userId: input.userId, code: input.code, make }, async () => {
    const minted = await minter.createApiKey({
      userId: input.userId,
      name: input.name,
      scopes: input.scopes,
      grantorScopes: input.grantorScopes,
      grantorKid: input.grantorKid,
      domainWhitelist: input.domainWhitelist,
      expiresAt: input.expiresAt,
      mode: input.mode,
    });
    return { ...minted, sessionId: live.id };
  });
}
