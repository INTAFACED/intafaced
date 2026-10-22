/**
 * Mint an API key only after the remaining of two enrolled passkeys verifies.
 * Refuse if none remain. Reuses requireVerifiedPasskey and mintApiKeyAfterPasskey.
 * No invented challenge.
 */
import type { Sql } from 'postgres';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { mintApiKeyAfterPasskey, requireVerifiedPasskey } from './mint-api-key-passkey.js';

export function remainingPasskeyMints(raw: unknown): void {
  requireVerifiedPasskey(raw);
}

export async function mintApiKeyAfterRemainingPasskey(
  minter: ApiKeyMinter,
  sql: Sql,
  input: {
    userId: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
    grantorKid?: string | null;
    domainWhitelist?: string[];
    expiresAt?: Date;
    mode?: 'live' | 'sandbox';
  },
): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox' }> {
  return mintApiKeyAfterPasskey(minter, sql, input);
}
