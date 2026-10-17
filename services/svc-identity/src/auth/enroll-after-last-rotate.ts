/**
 * Rotate an API key only after the newly enrolled passkey verifies following a last-unenroll.
 * Refuse if none remain. Reuses requireVerifiedPasskey and rotateApiKeyAfterPasskey.
 * No invented challenge.
 */
import type { Sql } from 'postgres';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { rotateApiKeyAfterPasskey } from './rotate-api-key-passkey.js';
import type { RotatedApiKey } from './rotate-api-key.js';

export function newlyEnrolledPasskeyRotates(raw: unknown): void {
  requireVerifiedPasskey(raw);
}

export async function rotateApiKeyAfterNewlyEnrolledPasskey(
  minter: ApiKeyMinter,
  sql: Sql,
  input: { userId: string; keyId: string; grantorScopes: readonly string[]; grantorKid?: string | null },
): Promise<RotatedApiKey> {
  return rotateApiKeyAfterPasskey(minter, sql, input);
}
