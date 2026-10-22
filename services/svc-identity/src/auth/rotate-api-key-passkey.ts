/**
 * Rotate an API key only after a verified passkey.
 * Empty creds → auth.passkey_missing. Creds without lastVerifiedAt →
 * auth.passkey_verify_unavailable. No invented challenge. AuthService mints the secret.
 */
import type { Sql } from 'postgres';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { MintApiKeyPasskeyError, requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { rotateApiKey } from './rotate-api-key.js';

export async function rotateApiKeyAfterPasskey(
  minter: ApiKeyMinter,
  sql: Sql,
  input: { userId: string; keyId: string; grantorScopes: readonly string[]; grantorKid?: string | null },
): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox'; revokedKeyId: string }> {
  const rows = await sql<Array<{ webauthn_creds: unknown }>>`
    SELECT webauthn_creds FROM users WHERE id = ${input.userId} LIMIT 1
  `;
  const user = rows[0];
  if (!user) throw new MintApiKeyPasskeyError('User not found', 'auth.not_found');
  requireVerifiedPasskey(user.webauthn_creds);
  return rotateApiKey(minter, sql, input);
}
