/**
 * Redeem a one-time recovery code to revoke all API keys.
 * Refuse if the code is spent or missing. Reuses hashToken and revokeAllApiKeys.
 * Not a redo of redeem-to-revoke-other-sessions.
 */
import type { Sql } from 'postgres';
import { hashToken } from './passwords.js';
import { revokeAllApiKeys } from './revoke-all-api-keys.js';

export class RedeemRecoveryRevokeKeysError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.recovery_missing' | 'auth.recovery_spent' | 'auth.recovery_invalid' | 'auth.not_found',
  ) {
    super(message);
    this.name = 'RedeemRecoveryRevokeKeysError';
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function recoveryCodeRevokesAllKeys(code: unknown): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    throw new RedeemRecoveryRevokeKeysError('Recovery code missing', 'auth.recovery_missing');
  }
}

export async function revokeAllApiKeysAfterRecoveryCode(
  sql: Sql,
  input: { userId: string; code: string },
): Promise<{ userId: string; revoked: number }> {
  recoveryCodeRevokesAllKeys(input.code);
  const rows = await sql<Array<{ recovery_code_hashes: unknown }>>`
    SELECT recovery_code_hashes FROM users WHERE id = ${input.userId} LIMIT 1
  `;
  const user = rows[0];
  if (!user) throw new RedeemRecoveryRevokeKeysError('User not found', 'auth.not_found');
  const hashes = asStringList(user.recovery_code_hashes);
  if (hashes.length === 0) {
    throw new RedeemRecoveryRevokeKeysError('Recovery code spent', 'auth.recovery_spent');
  }
  const hash = hashToken(input.code.trim());
  const idx = hashes.indexOf(hash);
  if (idx < 0) {
    throw new RedeemRecoveryRevokeKeysError('Recovery code invalid', 'auth.recovery_invalid');
  }
  const revoked = await revokeAllApiKeys(sql, input.userId, input.userId);
  const next = hashes.slice(0, idx).concat(hashes.slice(idx + 1));
  await sql`
    UPDATE users
       SET recovery_code_hashes = ${sql.json(next as never)}, updated_at = now()
     WHERE id = ${input.userId}
  `;
  return revoked;
}
