/**
 * Unbind one IP from an API key allowlist. Exact IPv4/IPv6 after trim.
 * No invented CIDR. The rest of the list stays. Empty after unbind stays open.
 */
import type { Sql } from 'postgres';
import { ApiKeyIpError } from './auth-service-ip.js';
import { normalizeIp } from './api-key-ip.js';

export async function unbindApiKeyIpAllowlist(
  sql: Sql,
  userId: string,
  keyId: string,
  rawIp: string,
): Promise<{ id: string; ipAllowlist: string[]; requireSignature: boolean; requireNonEmptyIpAllowlist: boolean }> {
  const ip = normalizeIp(rawIp);
  if (!ip) throw new ApiKeyIpError('Invalid IP', 'auth.ip_invalid');

  const current = await sql<
    Array<{ id: string; ip_allowlist: string[]; require_signature: boolean | null; require_non_empty_ip_allowlist: boolean | null }>
  >`
    SELECT id, ip_allowlist, require_signature, require_non_empty_ip_allowlist FROM api_keys
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
  `;
  const row = current[0];
  if (!row) throw new ApiKeyIpError('API key not found', 'auth.not_found');

  const list = row.ip_allowlist ?? [];
  const next = list.filter((entry) => normalizeIp(entry) !== ip);
  if (next.length === list.length) {
    throw new ApiKeyIpError('IP is not on the API key', 'auth.not_found');
  }

  // SET lists only ip_allowlist. Signing and its secret stay as they are.
  const updated = await sql<
    Array<{ id: string; ip_allowlist: string[]; require_signature: boolean | null; require_non_empty_ip_allowlist: boolean | null }>
  >`
    UPDATE api_keys
    SET ip_allowlist = ${next}
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
    RETURNING id, ip_allowlist, require_signature, require_non_empty_ip_allowlist
  `;
  const out = updated[0];
  if (!out) throw new ApiKeyIpError('API key not found', 'auth.not_found');
  return {
    id: out.id,
    ipAllowlist: out.ip_allowlist ?? [],
    requireSignature: out.require_signature === true,
    requireNonEmptyIpAllowlist: out.require_non_empty_ip_allowlist === true,
  };
}
