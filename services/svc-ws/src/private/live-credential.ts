/**
 * Live session / API-key check for `/private/stream`.
 *
 * JWT `exp` is not enough: a revoked credential still verifies until expiry.
 * Ownership snapshots are `{ id, userId, revoked }` only — no scopes, no flatten.
 * Transport / parse failure is `unavailable` (fail-closed). Never treat a
 * non-OK identity response (including 401) as live.
 */

import { apiKeyOwnershipSchema, sessionOwnershipSchema } from '@intafaced/contracts';

export type OwnershipSnapshot = {
  readonly id: string;
  readonly userId: string;
  readonly revoked: boolean;
};

export type LiveCredentialErrorCode =
  | 'unavailable'
  | 'auth.api_key_denied'
  | 'auth.api_key_revoked'
  | 'auth.session_denied'
  | 'auth.session_revoked';

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
  /** Static headers or a factory — HMAC timestamps go stale, so call on every GET. */
  readonly headers: HeadersInit | (() => HeadersInit);
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * GET `/internal/sessions/:id` and `/internal/api-keys/:id`.
 * 404 → null. Non-OK (including 401) / transport / parse → `unavailable`.
 * Body is parsed with the published ownership schemas — no invented fields.
 */
export function createIdentityOwnershipClient(options: IdentityOwnershipClientOptions): LiveCredentialPort {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function get(path: string, parse: (body: unknown) => OwnershipSnapshot): Promise<OwnershipSnapshot | null> {
    let response: Response;
    try {
      const headers = typeof options.headers === 'function' ? options.headers() : options.headers;
      response = await fetchImpl(`${baseUrl}${path}`, { headers });
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
        return { id: parsed.id, userId: parsed.userId, revoked: parsed.revoked };
      });
    },
  };
}
