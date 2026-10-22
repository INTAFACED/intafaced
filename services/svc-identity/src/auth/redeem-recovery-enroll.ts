/**
 * Redeem a one-time recovery code to enroll a new passkey.
 * Refuse if the code is missing, spent, or wrong. Reuses hashToken and StoredPasskey.
 * No invented challenge.
 */
import type { Sql } from 'postgres';
import type { StoredPasskey } from './enroll-passkey.js';
import { hashToken } from './passwords.js';

export class RedeemRecoveryEnrollError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.recovery_missing' | 'auth.recovery_spent' | 'auth.recovery_invalid' | 'auth.not_found',
  ) {
    super(message);
    this.name = 'RedeemRecoveryEnrollError';
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function asCreds(raw: unknown): StoredPasskey[] {
  return Array.isArray(raw) ? (raw as StoredPasskey[]) : [];
}

export function recoveryCodeEnrollsPasskey(code: unknown): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    throw new RedeemRecoveryEnrollError('Recovery code missing', 'auth.recovery_missing');
  }
}

export async function enrollPasskeyAfterRecoveryCode(
  sql: Sql,
  input: { userId: string; code: string; cred: StoredPasskey },
): Promise<{ credentialId: string }> {
  recoveryCodeEnrollsPasskey(input.code);
  const rows = await sql<Array<{ recovery_code_hashes: unknown; webauthn_creds: unknown }>>`
    SELECT recovery_code_hashes, webauthn_creds FROM users WHERE id = ${input.userId} LIMIT 1
  `;
  const user = rows[0];
  if (!user) throw new RedeemRecoveryEnrollError('User not found', 'auth.not_found');
  const hashes = asStringList(user.recovery_code_hashes);
  if (hashes.length === 0) {
    throw new RedeemRecoveryEnrollError('Recovery code spent', 'auth.recovery_spent');
  }
  const hash = hashToken(input.code.trim());
  const idx = hashes.indexOf(hash);
  if (idx < 0) {
    throw new RedeemRecoveryEnrollError('Recovery code invalid', 'auth.recovery_invalid');
  }
  const nextHashes = hashes.slice(0, idx).concat(hashes.slice(idx + 1));
  const nextCreds = [...asCreds(user.webauthn_creds), input.cred];
  await sql`
    UPDATE users
       SET recovery_code_hashes = ${sql.json(nextHashes as never)},
           webauthn_creds = ${sql.json(nextCreds as never)},
           updated_at = now()
     WHERE id = ${input.userId}
  `;
  return { credentialId: input.cred.credentialId };
}
