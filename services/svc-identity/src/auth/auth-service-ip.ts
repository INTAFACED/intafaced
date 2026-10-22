/**
 * Bind / refuse an API key IP allowlist without rewriting auth-service.ts.
 * Exchange still goes through AuthService; this wraps it so a non-listed IP
 * cannot mint a JWT. Empty list stays open. Missing IP fails closed.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Sql } from 'postgres';
import { AuthError, type AuthService } from './auth-service.js';
import { apiKeyIpAllowed, normalizeIp } from './api-key-ip.js';
import { hashToken } from './passwords.js';

export const requestIpAls = new AsyncLocalStorage<string | undefined>();

export class ApiKeyIpError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.ip_not_allowed' | 'auth.ip_invalid' | 'auth.not_found',
  ) {
    super(message);
    this.name = 'ApiKeyIpError';
  }
}

export async function bindApiKeyIpAllowlist(
  sql: Sql,
  userId: string,
  keyId: string,
  ips: string[],
): Promise<{ id: string; ipAllowlist: string[] }> {
  const next: string[] = [];
  for (const raw of ips) {
    const ip = normalizeIp(raw);
    if (!ip) throw new ApiKeyIpError('Invalid IP in allowlist', 'auth.ip_invalid');
    next.push(ip);
  }
  const rows = await sql<Array<{ id: string; ip_allowlist: string[] }>>`
    UPDATE api_keys
    SET ip_allowlist = ${next}
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
    RETURNING id, ip_allowlist
  `;
  const row = rows[0];
  if (!row) throw new ApiKeyIpError('API key not found', 'auth.not_found');
  return { id: row.id, ipAllowlist: row.ip_allowlist ?? [] };
}

/** Wrap exchange so a bound key cannot mint a JWT from a foreign / missing IP. */
export function installApiKeyIpExchange(auth: AuthService, sql: Sql): void {
  const orig = auth.exchangeApiKey.bind(auth);
  auth.exchangeApiKey = async (key: string, requestOrigin?: string | null) => {
    const rows = await sql<Array<{ ip_allowlist: string[] | null }>>`
      SELECT ip_allowlist FROM api_keys
      WHERE key_hash = ${hashToken(key)} AND revoked = false
    `;
    const row = rows[0];
    if (row && !apiKeyIpAllowed(row.ip_allowlist ?? [], requestIpAls.getStore())) {
      // Existing router maps domain_not_allowed → UNAUTHORIZED (same shape as origin refuse).
      throw new AuthError('API key is not allowed from this IP', 'auth.domain_not_allowed');
    }
    return orig(key, requestOrigin);
  };
}
