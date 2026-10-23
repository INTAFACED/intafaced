/**
 * Bind / refuse an API key origin allowlist without rewriting auth-service.ts.
 * Exchange already gates Origin via apiKeyOriginAllowed. Empty list stays unset
 * (not localhost). Invalid / blank origins refuse before write.
 */
import type { Sql } from 'postgres';
import { normalizeOriginHost } from './api-key-origin.js';

export class ApiKeyOriginError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.origin_invalid' | 'auth.not_found',
  ) {
    super(message);
    this.name = 'ApiKeyOriginError';
  }
}

export function normalizeOrigin(value: string | null | undefined): string | null {
  const host = normalizeOriginHost(value);
  if (!host || host === '*' || host.includes('*')) return null;
  return host;
}

/** Null when this user has no live key with that id. */
export async function loadApiKeyOriginAllowlist(sql: Sql, userId: string, keyId: string): Promise<string[] | null> {
  const rows = await sql<Array<{ domain_whitelist: string[] | null }>>`
    SELECT domain_whitelist FROM api_keys
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
  `;
  const row = rows[0];
  if (!row) return null;
  return row.domain_whitelist ?? [];
}

export async function bindApiKeyOriginAllowlist(
  sql: Sql,
  userId: string,
  keyId: string,
  origins: string[],
): Promise<{ id: string; originAllowlist: string[] }> {
  const next: string[] = [];
  for (const raw of origins) {
    const origin = normalizeOrigin(raw);
    if (!origin) throw new ApiKeyOriginError('Invalid origin in allowlist', 'auth.origin_invalid');
    next.push(origin);
  }
  const rows = await sql<Array<{ id: string; domain_whitelist: string[] }>>`
    UPDATE api_keys
    SET domain_whitelist = ${next}
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
    RETURNING id, domain_whitelist
  `;
  const row = rows[0];
  if (!row) throw new ApiKeyOriginError('API key not found', 'auth.not_found');
  return { id: row.id, originAllowlist: row.domain_whitelist ?? [] };
}
