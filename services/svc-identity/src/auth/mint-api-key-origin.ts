/**
 * Mint an API key with the origin allowlist already bound.
 * Hostname after trim/URL parse. No invented localhost. Empty list stays unset.
 * Invalid origins refuse before create — no leftover unbound key.
 */
import type { Sql } from 'postgres';
import { ApiKeyOriginError, bindApiKeyOriginAllowlist, normalizeOrigin } from './auth-service-origin.js';
import type { ApiKeyMinter } from './mint-api-key-ip.js';

export async function mintApiKeyWithOriginAllowlist(
  minter: ApiKeyMinter,
  sql: Sql,
  input: {
    userId: string;
    name: string;
    scopes: string[];
    grantorScopes: readonly string[];
    grantorKid?: string | null;
    origins: string[];
    expiresAt?: Date;
    mode?: 'live' | 'sandbox';
  },
): Promise<{ id: string; key: string; prefix: string; mode: 'live' | 'sandbox'; originAllowlist: string[] }> {
  const next: string[] = [];
  for (const raw of input.origins) {
    const origin = normalizeOrigin(raw);
    if (!origin) throw new ApiKeyOriginError('Invalid origin in allowlist', 'auth.origin_invalid');
    next.push(origin);
  }

  const minted = await minter.createApiKey({
    userId: input.userId,
    name: input.name,
    scopes: input.scopes,
    grantorScopes: input.grantorScopes,
    grantorKid: input.grantorKid,
    domainWhitelist: next,
    expiresAt: input.expiresAt,
    mode: input.mode,
  });

  try {
    const bound = await bindApiKeyOriginAllowlist(sql, input.userId, minted.id, next);
    return { ...minted, originAllowlist: bound.originAllowlist };
  } catch (err) {
    await minter.revokeApiKey(input.userId, minted.id, 'system');
    throw err;
  }
}
