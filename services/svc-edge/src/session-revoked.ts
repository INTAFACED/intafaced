/**
 * Identity session ownership at the HTTP session door (#3343 / #3346 / #3348).
 * A revoked session cannot open. An active session proceeds.
 * Consume GET /internal/sessions/:id — no second store. Never invent live.
 */

import { sessionOwnershipSchema } from '@intafaced/contracts';
import { identityCallHeaders, type EdgeS2s } from './s2s.js';

export class SessionRevokedError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.session_revoked' | 'auth.session_denied',
  ) {
    super(message);
    this.name = 'SessionRevokedError';
  }
}

/** Identity ownership body only. Never invent a revoke. */
export function optionalSessionRevoked(body: unknown): boolean | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  const raw = rec.revoked;
  if (typeof raw !== 'boolean') return undefined;
  return raw;
}

/** Walk a tRPC envelope or a bare body. Never invent a revoke. */
export function optionalSessionRevokedFromExchange(body: unknown): boolean | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const envelope = body as {
    result?: { data?: { json?: unknown; revoked?: unknown } };
    revoked?: unknown;
  };
  const data = envelope.result?.data?.json ?? envelope.result?.data ?? body;
  return optionalSessionRevoked(data);
}

/** Revoked cannot open a session. Missing stays open (no invented live-check). */
export function sessionIsRevoked(revoked: boolean | null | undefined): boolean {
  return revoked === true;
}

export function assertSessionNotRevoked(revoked: boolean | null | undefined): void {
  if (sessionIsRevoked(revoked)) {
    throw new SessionRevokedError('Session is revoked', 'auth.session_revoked');
  }
}

export interface LoadSessionOwnershipOptions {
  readonly identityUrl: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly identityOwnershipSecret: string;
  /** The edge's own key. Absent leaves the call on `identityOwnershipSecret` alone. */
  readonly s2s?: EdgeS2s | undefined;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Identity GET /internal/sessions/:id. 404 / mismatch → denied.
 * Transport / non-OK (including 401) / parse → denied (fail-closed, not live).
 * `revoked: true` → revoked. Never invent live.
 */
export async function assertIdentitySessionLive(options: LoadSessionOwnershipOptions): Promise<void> {
  const id = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  if (!id) {
    throw new SessionRevokedError('Session not found', 'auth.session_denied');
  }
  const base = options.identityUrl.replace(/\/+$/, '');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const target = `${base}/internal/sessions/${encodeURIComponent(id)}`;
  const headers = identityCallHeaders(options.identityOwnershipSecret, options.s2s, { method: 'GET', target, body: '', contentType: '' });
  let response: Response;
  try {
    response = await fetchFn(target, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new SessionRevokedError('Session not found', 'auth.session_denied');
  }
  if (response.status === 404) {
    throw new SessionRevokedError('Session not found', 'auth.session_denied');
  }
  if (!response.ok) {
    throw new SessionRevokedError('Session not found', 'auth.session_denied');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SessionRevokedError('Session not found', 'auth.session_denied');
  }
  const parsed = sessionOwnershipSchema.safeParse(body);
  if (!parsed.success) {
    throw new SessionRevokedError('Session not found', 'auth.session_denied');
  }
  if (parsed.data.id !== id || parsed.data.userId !== options.userId) {
    throw new SessionRevokedError('Session not found', 'auth.session_denied');
  }
  assertSessionNotRevoked(parsed.data.revoked);
}
