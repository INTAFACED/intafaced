/**
 * Redeem a one-time recovery code to enroll a new passkey.
 * Refuse if the code is missing, spent, or wrong. Reuses StoredPasskey.
 * The credential is appended under the same row lock discipline as every other factor write.
 * No invented challenge.
 * Spends the code through `redeemRecoveryCode` (recovery-redeem.ts): the `mfa` attempt is
 * reserved first, the code is claimed under `SELECT ... FOR UPDATE`, so it can never be
 * used twice, and a success clears the counter.
 */
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import type { StoredPasskey } from './enroll-passkey.js';
import { queueFactorChangedNotice } from './factor-changed-notice.js';
import { assertOwnLiveSession, redeemRecoveryCode, type RecoveryRedeemCode } from './recovery-redeem.js';

export class RedeemRecoveryEnrollError extends Error {
  constructor(
    message: string,
    readonly code: RecoveryRedeemCode,
  ) {
    super(message);
    this.name = 'RedeemRecoveryEnrollError';
  }
}

const make = (message: string, code: RecoveryRedeemCode) => new RedeemRecoveryEnrollError(message, code);

export function recoveryCodeEnrollsPasskey(code: unknown): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    throw make('Recovery code missing', 'auth.recovery_missing');
  }
}

export async function enrollPasskeyAfterRecoveryCode(
  sql: Sql,
  input: { userId: string; code: string; cred: StoredPasskey },
): Promise<{ credentialId: string }> {
  recoveryCodeEnrollsPasskey(input.code);
  return redeemRecoveryCode(sql, { userId: input.userId, code: input.code, make }, async () => {
    await transaction(sql, async (tx) => {
      const rows = await tx<Array<{ webauthn_creds: unknown }>>`SELECT webauthn_creds FROM users WHERE id = ${input.userId} FOR UPDATE`;
      if (!rows[0]) throw make('User not found', 'auth.not_found');
      const creds = Array.isArray(rows[0].webauthn_creds) ? (rows[0].webauthn_creds as StoredPasskey[]) : [];
      await tx`UPDATE users SET webauthn_creds = ${tx.json([...creds, input.cred] as never)}, updated_at = now() WHERE id = ${input.userId}`;
      await queueFactorChangedNotice(tx, { userId: input.userId, change: 'passkey_added', now: new Date() });
    });
    return { credentialId: input.cred.credentialId };
  });
}
