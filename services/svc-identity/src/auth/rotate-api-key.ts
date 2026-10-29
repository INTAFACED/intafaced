/**
 * Rotate an API key. The old key is revoked (cannot place).
 * The new key is minted by AuthService — no invented secret.
 * Same name, scopes, mode, domain list, expiry, IP allowlist, account bind, sandbox.
 */
import type { Sql } from 'postgres';
import { bindApiKeyAccount } from './bind-api-key-account.js';
import { bindApiKeyIpAllowlist } from './auth-service-ip.js';
import { issueSigningSecret } from './api-key-request-sign.js';
import type { ApiKeyMinter } from './mint-api-key-ip.js';
import { copySandboxLink } from './sandbox-key-link.js';
import { encryptAtRest } from './totp-crypto.js';

export class RotateApiKeyError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.not_found' | 'auth.not_configured',
  ) {
    super(message);
    this.name = 'RotateApiKeyError';
  }
}

export type RotatedApiKey = {
  id: string;
  key: string;
  prefix: string;
  mode: 'live' | 'sandbox';
  revokedKeyId: string;
  /** Plaintext once, when the old key required a signature. Null otherwise. */
  signingSecret: string | null;
};

export async function rotateApiKey(
  minter: ApiKeyMinter,
  sql: Sql,
  input: { userId: string; keyId: string; grantorScopes: readonly string[]; grantorKid?: string | null },
  encKey: Buffer | null = null,
): Promise<RotatedApiKey> {
  const rows = await sql<
    Array<{
      id: string;
      name: string;
      scopes: string[];
      domain_whitelist: string[] | null;
      expires_at: Date | null;
      mode: string | null;
      ip_allowlist: string[] | null;
      account_id: string | null;
      require_signature: boolean | null;
      require_non_empty_ip_allowlist: boolean | null;
    }>
  >`
    SELECT id, name, scopes, domain_whitelist, expires_at, mode, ip_allowlist, account_id,
           require_signature, require_non_empty_ip_allowlist
    FROM api_keys
    WHERE id = ${input.keyId} AND user_id = ${input.userId} AND revoked = false
  `;
  const old = rows[0];
  if (!old) throw new RotateApiKeyError('API key not found', 'auth.not_found');
  const requireSignature = old.require_signature === true;
  const requireNonEmptyIpAllowlist = old.require_non_empty_ip_allowlist === true;
  if (requireSignature && !encKey) {
    throw new RotateApiKeyError('API key signing is not configured', 'auth.not_configured');
  }

  const minted = await minter.createApiKey({
    userId: input.userId,
    name: old.name,
    scopes: old.scopes,
    grantorScopes: input.grantorScopes,
    grantorKid: input.grantorKid,
    domainWhitelist: old.domain_whitelist ?? [],
    expiresAt: old.expires_at ?? undefined,
    mode: old.mode === 'sandbox' ? 'sandbox' : 'live',
  });

  let signingSecret: string | null = null;
  try {
    if (requireSignature) {
      signingSecret = issueSigningSecret();
    }
    await sql`
      UPDATE api_keys
      SET require_signature = ${requireSignature},
          require_non_empty_ip_allowlist = ${requireNonEmptyIpAllowlist},
          request_signing_secret = ${signingSecret && encKey ? encryptAtRest(encKey, signingSecret) : null}
      WHERE id = ${minted.id} AND user_id = ${input.userId} AND revoked = false
    `;
    if (old.account_id) {
      await bindApiKeyAccount(sql, input.userId, minted.id, old.account_id);
    }
    await copySandboxLink(sql, old.id, minted.id);
    const ips = old.ip_allowlist ?? [];
    if (ips.length > 0) {
      await bindApiKeyIpAllowlist(sql, input.userId, minted.id, ips);
    }
    const revoked = await minter.revokeApiKey(input.userId, old.id);
    if (!revoked) throw new RotateApiKeyError('API key not found', 'auth.not_found');
    return { ...minted, revokedKeyId: old.id, signingSecret };
  } catch (err) {
    await minter.revokeApiKey(input.userId, minted.id);
    throw err;
  }
}
