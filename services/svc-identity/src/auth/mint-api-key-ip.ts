/**
 * Mint an API key with the IP allowlist already bound.
 * Exact IPv4/IPv6 after trim. No invented CIDR. Empty list stays open.
 * Invalid IPs refuse before create — no leftover unbound key.
 */
import type { Sql } from 'postgres';
import type { ApiKeyRevokedBy } from '@intafaced/contracts/api-keys';
import { ApiKeyIpError, bindApiKeyIpAllowlist } from './auth-service-ip.js';
import { normalizeIp } from './api-key-ip.js';

export type ApiKeyMinter = {
  createApiKey(input: {
    userId: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
    grantorKid?: string | null;
    domainWhitelist?: string[];
    expiresAt?: Date;
    mode?: 'live' | 'sandbox';
  }): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox' }>;
  /** `cause` is `system` when undoing a key that was never handed over; the person's own revoke leaves it out. */
  revokeApiKey(userId: string, keyId: string, cause?: ApiKeyRevokedBy): Promise<boolean>;
};

export async function mintApiKeyWithIpAllowlist(
  minter: ApiKeyMinter,
  sql: Sql,
  input: {
    userId: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
    grantorKid?: string | null;
    ips: string[];
    domainWhitelist?: string[];
    expiresAt?: Date;
    mode?: 'live' | 'sandbox';
  },
): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox'; ipAllowlist: string[] }> {
  const next: string[] = [];
  for (const raw of input.ips) {
    const ip = normalizeIp(raw);
    if (!ip) throw new ApiKeyIpError('Invalid IP in allowlist', 'auth.ip_invalid');
    next.push(ip);
  }

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

  try {
    const bound = await bindApiKeyIpAllowlist(sql, input.userId, minted.id, next);
    return { ...minted, ipAllowlist: bound.ipAllowlist };
  } catch (err) {
    await minter.revokeApiKey(input.userId, minted.id, 'system');
    throw err;
  }
}
