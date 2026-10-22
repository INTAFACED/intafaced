/**
 * Mint an API key with the IP allowlist already bound.
 * Exact IPv4/IPv6 after trim. No invented CIDR. Empty list stays open.
 * Invalid IPs refuse before create — no leftover unbound key.
 */
import type { Sql } from 'postgres';
import { ApiKeyIpError, bindApiKeyIpAllowlist } from './auth-service-ip.js';
import { normalizeIp } from './api-key-ip.js';

export type ApiKeyMinter = {
  createApiKey(input: {
    userId: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
    domainWhitelist?: string[];
    expiresAt?: Date;
    mode?: 'live' | 'sandbox';
  }): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox' }>;
  revokeApiKey(userId: string, keyId: string): Promise<boolean>;
};

export async function mintApiKeyWithIpAllowlist(
  minter: ApiKeyMinter,
  sql: Sql,
  input: {
    userId: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
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
    domainWhitelist: input.domainWhitelist,
    expiresAt: input.expiresAt,
    mode: input.mode,
  });

  try {
    const bound = await bindApiKeyIpAllowlist(sql, input.userId, minted.id, next);
    return { ...minted, ipAllowlist: bound.ipAllowlist };
  } catch (err) {
    await minter.revokeApiKey(input.userId, minted.id);
    throw err;
  }
}
