/**
 * Mint a one-time recovery code only after a verified passkey.
 * Refuse if none enrolled. Reuses requireVerifiedPasskey and generateRecoveryCodes.
 * Hash stored; plaintext returned once. No invented challenge.
 */
import type { Sql } from 'postgres';
import { MintApiKeyPasskeyError, requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { hashToken } from './passwords.js';
import { generateRecoveryCodes } from './totp.js';

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function verifiedPasskeyMintsRecoveryCode(raw: unknown): void {
  requireVerifiedPasskey(raw);
}

export async function mintRecoveryCodeAfterPasskey(
  sql: Sql,
  input: { userId: string },
): Promise<{ code: string }> {
  const rows = await sql<Array<{ webauthn_creds: unknown; recovery_code_hashes: unknown }>>`
    SELECT webauthn_creds, recovery_code_hashes FROM users WHERE id = ${input.userId} LIMIT 1
  `;
  const user = rows[0];
  if (!user) throw new MintApiKeyPasskeyError('User not found', 'auth.not_found');
  requireVerifiedPasskey(user.webauthn_creds);
  const [code] = generateRecoveryCodes(1);
  const hashes = asStringList(user.recovery_code_hashes);
  hashes.push(hashToken(code));
  await sql`
    UPDATE users
       SET recovery_code_hashes = ${sql.json(hashes as never)}, updated_at = now()
     WHERE id = ${input.userId}
  `;
  return { code };
}
