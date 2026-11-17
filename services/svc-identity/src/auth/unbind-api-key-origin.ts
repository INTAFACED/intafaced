/**
 * Unbind one origin from an API key allowlist. Hostname after trim/URL parse.
 * The rest of the list stays. Empty after unbind stays unset (not localhost).
 */
import type { Queryable } from '@intafaced/db';
import { ApiKeyOriginError, normalizeOrigin } from './auth-service-origin.js';

export async function unbindApiKeyOriginAllowlist(
  sql: Queryable,
  userId: string,
  keyId: string,
  rawOrigin: string,
): Promise<{ id: string; originAllowlist: string[] }> {
  const origin = normalizeOrigin(rawOrigin);
  if (!origin) throw new ApiKeyOriginError('Invalid origin', 'auth.origin_invalid');

  const current = await sql<Array<{ id: string; domain_whitelist: string[] }>>`
    SELECT id, domain_whitelist FROM api_keys
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
  `;
  const row = current[0];
  if (!row) throw new ApiKeyOriginError('API key not found', 'auth.not_found');

  const list = row.domain_whitelist ?? [];
  const next = list.filter((entry) => normalizeOrigin(entry) !== origin);
  if (next.length === list.length) {
    throw new ApiKeyOriginError('Origin is not on the API key', 'auth.not_found');
  }

  const updated = await sql<Array<{ id: string; domain_whitelist: string[] }>>`
    UPDATE api_keys
    SET domain_whitelist = ${next}
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
    RETURNING id, domain_whitelist
  `;
  const out = updated[0];
  if (!out) throw new ApiKeyOriginError('API key not found', 'auth.not_found');
  return { id: out.id, originAllowlist: out.domain_whitelist ?? [] };
}
