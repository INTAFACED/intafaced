import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../../shared/api';

/**
 * API keys (M9). The back end (svc-identity) is checked on origin/main:
 *  - `apiKeys.list { limit 1..200 }` -> [{ id, name, prefix, scopes, lastUsedAt, revoked, mode }]  (identity:read)
 *  - `apiKeys.create { name, scopes, domainWhitelist?, mode? }` -> { id, key, prefix, mode }  (identity:write)
 *  - `mintApiKeyWithIpAllowlist { name, scopes, ips, ... }` -> same + ipAllowlist  (identity:write)
 *  - `apiKeys.revoke { keyId }` -> { revoked }  (identity:write)
 * Both create calls refuse unless the account has a passkey that has passed `verifyPasskey` once. Withdraw scopes
 * can never be put on a key (`assertKeyScopesAllowed`), so this screen never offers them.
 */

export const LIST_LIMIT = 200;

export type Permission = 'read' | 'trade';

/** What each permission puts on the key. Trade needs Read to be useful (orders are listed under trade:read). */
const SCOPES: Record<Permission, readonly string[]> = {
  read: ['trade:read'],
  trade: ['trade:read', 'trade:write'],
};

export function scopesFor(permissions: ReadonlySet<Permission>): string[] {
  const out = new Set<string>();
  for (const permission of permissions) for (const scope of SCOPES[permission]) out.add(scope);
  return [...out];
}

export interface PermissionView {
  read: boolean;
  trade: boolean;
  /** Scopes this screen does not hand out (a key made elsewhere, for example by Pay). Shown as "Other access". */
  other: boolean;
}

export function permissionsOf(scopes: readonly string[]): PermissionView {
  const known = new Set<string>(['trade:read', 'trade:write']);
  return {
    read: scopes.includes('trade:read'),
    trade: scopes.includes('trade:write'),
    other: scopes.some((scope) => !known.has(scope)),
  };
}

const record = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  lastUsedAt: z.string().nullable(),
  revoked: z.boolean(),
  mode: z.enum(['live', 'sandbox']),
});
export type ApiKeyRow = z.infer<typeof record>;

export function readKeys(api: ApiClient, signal: AbortSignal): Promise<ApiResult<ApiKeyRow[]>> {
  return api.query('identity', 'apiKeys.list', { limit: LIST_LIMIT }, z.array(record), { signal });
}

const created = z.object({ id: z.string(), key: z.string().min(1), prefix: z.string(), mode: z.enum(['live', 'sandbox']) }).passthrough();
export type CreatedKey = z.infer<typeof created>;

export const NAME_MAX = 64;
export const nameError = (raw: string): 'empty' | 'long' | null => {
  const name = raw.trim();
  return name.length === 0 ? 'empty' : name.length > NAME_MAX ? 'long' : null;
};

export function createKey(
  api: ApiClient,
  input: { name: string; permissions: ReadonlySet<Permission>; ips: readonly string[] },
  signal?: AbortSignal,
): Promise<ApiResult<CreatedKey>> {
  const name = input.name.trim();
  const scopes = scopesFor(input.permissions);
  // An empty list means "any address"; the plain create is used so nothing is bound that the person did not ask for.
  return input.ips.length > 0
    ? api.mutate('identity', 'mintApiKeyWithIpAllowlist', { name, scopes, ips: [...input.ips] }, created, { signal })
    : api.mutate('identity', 'apiKeys.create', { name, scopes }, created, { signal });
}

export function revokeKey(api: ApiClient, keyId: string, signal?: AbortSignal): Promise<ApiResult<{ revoked: boolean }>> {
  return api.mutate('identity', 'apiKeys.revoke', { keyId }, z.object({ revoked: z.boolean() }), { signal });
}

// ── The IP allow-list ───────────────────────────────────────────────────────

const octet = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const ipv4 = new RegExp(`^${octet}(\\.${octet}){3}$`);

/** Exact IPv4 or IPv6 (no ranges: the service takes single addresses). The service stays the authority. */
export function isValidIp(value: string): boolean {
  if (ipv4.test(value)) return true;
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * The form the service will compare against: IPv4 as typed, IPv6 lower-case and compressed. The service matches
 * the request address as an exact string, so `2001:DB8::1` typed here would never match and the key would be locked out.
 */
export function canonicalIp(value: string): string {
  if (ipv4.test(value)) return value;
  try {
    return new URL(`http://[${value}]/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return value;
  }
}

export interface AllowList {
  ips: string[];
  invalid: string[];
}

/** Commas, spaces and new lines all separate addresses; repeats are dropped, order is kept. */
export function parseAllowList(text: string): AllowList {
  const seen = new Set<string>();
  const ips: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const typed = raw.trim();
    if (!typed) continue;
    const entry = isValidIp(typed) ? canonicalIp(typed) : typed;
    if (seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    (isValidIp(typed) ? ips : invalid).push(entry);
  }
  return { ips, invalid };
}

// ── Why a create was refused ────────────────────────────────────────────────

export type CreateFailureKind =
  /** No passkey on the account at all. */
  | 'passkey-missing'
  /** A passkey exists but has never been confirmed: the person can do that here. */
  | 'passkey-unconfirmed'
  | 'bad-ip'
  /** The answer was lost on the way: a key may or may not exist. */
  | 'uncertain'
  | 'signed-out'
  | 'other';

export function classifyCreateFailure(failure: Extract<ApiResult<unknown>, { ok: false }>): CreateFailureKind {
  const text = `${failure.code ?? ''} ${failure.message}`.toLowerCase();
  if (failure.reason === 'unauthorized') return 'signed-out';
  if (failure.reason === 'uncertain') return 'uncertain';
  if (text.includes('passkey_verify_unavailable') || text.includes('passkey verify')) return 'passkey-unconfirmed';
  if (text.includes('passkey_missing') || text.includes('no enrolled passkey')) return 'passkey-missing';
  if (text.includes('ip_invalid') || text.includes('invalid ip')) return 'bad-ip';
  return 'other';
}
