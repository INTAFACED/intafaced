/**
 * Revoke all recovery codes only after a verified passkey.
 * Refuse if none enrolled. Reuses requireVerifiedPasskey.
 * No invented challenge.
 */
import type { Sql } from 'postgres';
import { MintApiKeyPasskeyError, requireVerifiedPasskey } from './mint-api-key-passkey.js';

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function verifiedPasskeyRevokesAllRecoveryCodes(raw: unknown): void {
  requireVerifiedPasskey(raw);
}

export async function revokeAllRecoveryCodesAfterPasskey(sql: Sql, input: { userId: string }): Promise<{ revoked: number }> {
  const rows = await sql<Array<{ webauthn_creds: unknown; recovery_code_hashes: unknown }>>`
    SELECT webauthn_creds, recovery_code_hashes FROM users WHERE id = ${input.userId} LIMIT 1
  `;
  const user = rows[0];
  if (!user) throw new MintApiKeyPasskeyError('User not found', 'auth.not_found');
  requireVerifiedPasskey(user.webauthn_creds);
  const hashes = asStringList(user.recovery_code_hashes);
  await sql`
    UPDATE users
       SET recovery_code_hashes = ${sql.json([] as never)}, updated_at = now()
     WHERE id = ${input.userId}
  `;
  return { revoked: hashes.length };
}
