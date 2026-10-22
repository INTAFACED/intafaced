/** Enrolled passkey at the HTTP session door. A session without it cannot place. Refuse if verify is unavailable. Never invent a challenge. */

import { serviceAuthHeaders } from '@intafaced/contracts';

export class SessionPasskeyError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.passkey_missing' | 'auth.passkey_verify_unavailable',
  ) {
    super(message);
    this.name = 'SessionPasskeyError';
  }
}

/** Walk a tRPC envelope or a bare body. Identity body only — never invent fields. */
function identityAccountBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const envelope = body as {
    result?: { data?: { json?: unknown } };
  };
  return envelope.result?.data?.json ?? envelope.result?.data ?? body;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Identity body only. Never invent enrolled creds. Missing field → undefined (not []). */
export function optionalPasskeyCreds(body: unknown): unknown[] | undefined {
  const data = identityAccountBody(body);
  if (!data || typeof data !== 'object') return undefined;
  const rec = data as Record<string, unknown>;
  const raw = rec.webauthnCreds ?? rec.webauthn_creds;
  if (!Array.isArray(raw)) return undefined;
  return raw;
}

/**
 * Identity body only. Never invent a clock.
 * Reads lastVerifiedAt / last_verified_at on the body, or on any cred with a non-empty string.
 */
export function optionalLastVerifiedAt(body: unknown): string | undefined {
  const data = identityAccountBody(body);
  if (!data || typeof data !== 'object') return undefined;
  const rec = data as Record<string, unknown>;
  const top = nonEmptyString(rec.lastVerifiedAt ?? rec.last_verified_at);
  if (top) return top;
  const creds = optionalPasskeyCreds(data);
  if (!creds) return undefined;
  for (const cred of creds) {
    if (!cred || typeof cred !== 'object') continue;
    const row = cred as Record<string, unknown>;
    const at = nonEmptyString(row.lastVerifiedAt ?? row.last_verified_at);
    if (at) return at;
  }
  return undefined;
}

/** Identity body only. Never invent verified. Reads passkeyVerified / verified if boolean. */
export function optionalPasskeyVerified(body: unknown): boolean | undefined {
  const data = identityAccountBody(body);
  if (!data || typeof data !== 'object') return undefined;
  const rec = data as Record<string, unknown>;
  const raw = rec.passkeyVerified ?? rec.verified;
  if (typeof raw !== 'boolean') return undefined;
  return raw;
}

function unavailable(message = 'passkey verify is unavailable'): never {
  throw new SessionPasskeyError(message, 'auth.passkey_verify_unavailable');
}

function missing(): never {
  throw new SessionPasskeyError('No enrolled passkey', 'auth.passkey_missing');
}

/** Enrolled + identity-verified passkey may place. Never invent enrolled/verified. Never invent a challenge. */
export function assertSessionPasskey(body: unknown): void {
  if (optionalPasskeyVerified(body) === true) return;
  const lastVerifiedAt = optionalLastVerifiedAt(body);
  if (lastVerifiedAt) return;
  const creds = optionalPasskeyCreds(body);
  if (creds === undefined) unavailable();
  if (creds.length === 0) missing();
  // Creds present but identity has not persisted lastVerifiedAt — do not invent a challenge.
  unavailable();
}

export interface LoadSessionPasskeyOptions {
  readonly identityUrl: string;
  readonly userId: string;
  readonly identityOwnershipSecret: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Identity GET /internal/account/:userId. Own GET so the freeze door is not rewritten.
 * Transport / non-OK (including 401/403/404) / parse / userId mismatch → verify unavailable (fail-closed).
 * Then assertSessionPasskey on the raw body (accountStateSchema strips extras).
 */
export async function assertIdentitySessionPasskey(options: LoadSessionPasskeyOptions): Promise<void> {
  const id = typeof options.userId === 'string' ? options.userId.trim() : '';
  if (!id) unavailable();
  const base = options.identityUrl.replace(/\/+$/, '');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const headers = serviceAuthHeaders('svc-edge', options.identityOwnershipSecret);
  let response: Response;
  try {
    response = await fetchFn(`${base}/internal/account/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    unavailable();
  }
  if (!response.ok) unavailable();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    unavailable();
  }
  if (body && typeof body === 'object' && 'userId' in body) {
    const rec = body as Record<string, unknown>;
    if (rec.userId !== id) unavailable();
  }
  assertSessionPasskey(body);
}
