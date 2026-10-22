/**
 * Live session / API-key check for `/private/stream`.
 *
 * JWT `exp` is not enough: a revoked credential still verifies until expiry.
 * Ownership snapshots are `{ id, userId, revoked }` only — no scopes, no flatten.
 * An API-key snapshot may also carry `ipAllowlist` when identity sends it.
 * Transport / parse failure is `unavailable` (fail-closed). Never treat a
 * non-OK identity response (including 401) as live.
 */

import { apiKeyOwnershipSchema, sessionOwnershipSchema } from '@intafaced/contracts';
import { apiKeyIpAllowed } from './caller-ip.js';

export type OwnershipSnapshot = {
  readonly id: string;
  readonly userId: string;
  readonly revoked: boolean;
  /** API-key only. Empty / omitted = open. Never invent CIDR. */
  readonly ipAllowlist?: readonly string[];
};

export type LiveCredentialErrorCode =
  'unavailable' | 'auth.api_key_denied' | 'auth.api_key_revoked' | 'auth.ip_not_allowed' | 'auth.session_denied' | 'auth.session_revoked';

export class LiveCredentialError extends Error {
  constructor(
    message: string,
    readonly code: LiveCredentialErrorCode,
  ) {
    super(message);
    this.name = 'LiveCredentialError';
  }
}

export interface LiveCredentialPort {
  getSession(sessionId: string): Promise<OwnershipSnapshot | null>;
  getApiKey(keyId: string): Promise<OwnershipSnapshot | null>;
}

export type LiveCredentialInput = {
  readonly userId: string;
  readonly sessionId: string;
  readonly apiKeyId?: string;
  /** Upgrade / live-check caller. Session seats ignore it. */
  readonly callerIp?: string | null;
};

function unavailable(cause?: unknown): LiveCredentialError {
  const err = new LiveCredentialError('Live credential source unavailable', 'unavailable');
  if (cause !== undefined) {
    (err as Error & { cause?: unknown }).cause = cause;
  }
  return err;
}

async function load(read: () => Promise<OwnershipSnapshot | null>): Promise<OwnershipSnapshot | null> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof LiveCredentialError) throw err;
    throw unavailable(err);
  }
}

function denyKey(): never {
  throw new LiveCredentialError('API key not found', 'auth.api_key_denied');
}

function denySession(): never {
  throw new LiveCredentialError('Session not found', 'auth.session_denied');
}

/**
 * Kid present → API key. Otherwise session (`sid` is always on the token).
 * Missing / empty / unknown / user mismatch → denied. `revoked: true` → revoked.
 * Bound key + caller IP not on the list → `auth.ip_not_allowed`.
 * Port `unavailable` propagates (fail-closed).
 */
export async function assertLiveCredential(port: LiveCredentialPort, input: LiveCredentialInput): Promise<OwnershipSnapshot> {
  if (input.apiKeyId !== undefined) {
    const id = typeof input.apiKeyId === 'string' ? input.apiKeyId.trim() : '';
    if (!id) denyKey();
    const row = await load(() => port.getApiKey(id));
    if (!row || row.id !== id || row.userId !== input.userId) denyKey();
    if (row.revoked) {
      throw new LiveCredentialError('API key is revoked', 'auth.api_key_revoked');
    }
    if (!apiKeyIpAllowed(row.ipAllowlist ?? [], input.callerIp)) {
      throw new LiveCredentialError('Caller IP is not on the API key', 'auth.ip_not_allowed');
    }
    return { id: row.id, userId: row.userId, revoked: false };
  }

  const id = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!id) denySession();
  const row = await load(() => port.getSession(id));
  if (!row || row.id !== id || row.userId !== input.userId) denySession();
  if (row.revoked) {
    throw new LiveCredentialError('Session is revoked', 'auth.session_revoked');
  }
  return { id: row.id, userId: row.userId, revoked: false };
}

export interface IdentityOwnershipClientOptions {
  readonly baseUrl: string;
  readonly headers: HeadersInit;
  readonly fetch?: typeof globalThis.fetch;
}

/** Read an optional string[] off the raw body. Schema-unknown — not invented. */
export function optionalIpAllowlist(body: unknown): readonly string[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  const raw = rec.ipAllowlist ?? rec.ip_allowlist;
  if (!Array.isArray(raw)) return undefined;
  if (!raw.every((entry) => typeof entry === 'string')) return undefined;
  return raw;
}

/**
 * GET `/internal/sessions/:id` and `/internal/api-keys/:id`.
 * 404 → null. Non-OK (including 401) / transport / parse → `unavailable`.
 * Body is parsed with the published ownership schemas — no invented fields.
 * A string[] `ipAllowlist` / `ip_allowlist` on the key body is kept locally.
 */
export function createIdentityOwnershipClient(options: IdentityOwnershipClientOptions): LiveCredentialPort {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function get(path: string, parse: (body: unknown) => OwnershipSnapshot): Promise<OwnershipSnapshot | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { headers: options.headers });
    } catch (err) {
      throw unavailable(err);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw unavailable();
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw unavailable(err);
    }
    try {
      return parse(body);
    } catch (err) {
      throw unavailable(err);
    }
  }

  return {
    getSession(sessionId) {
      return get(`/internal/sessions/${encodeURIComponent(sessionId)}`, (body) => {
        const parsed = sessionOwnershipSchema.parse(body);
        return { id: parsed.id, userId: parsed.userId, revoked: parsed.revoked };
      });
    },
    getApiKey(keyId) {
      return get(`/internal/api-keys/${encodeURIComponent(keyId)}`, (body) => {
        const parsed = apiKeyOwnershipSchema.parse(body);
        const ipAllowlist = optionalIpAllowlist(body);
        return ipAllowlist === undefined
          ? { id: parsed.id, userId: parsed.userId, revoked: parsed.revoked }
          : { id: parsed.id, userId: parsed.userId, revoked: parsed.revoked, ipAllowlist };
      });
    },
  };
}
