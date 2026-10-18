/**
 * Identity API-key ownership at the HTTP session door (#3346).
 * A revoked key-minted JWT cannot open. An active key proceeds.
 * Consume GET /internal/api-keys/:id — no second store. Never invent live.
 */

import { apiKeyOwnershipSchema, serviceAuthHeadersForBody } from '@intafaced/contracts';

export class ApiKeyRevokedError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.api_key_revoked' | 'auth.api_key_denied',
  ) {
    super(message);
    this.name = 'ApiKeyRevokedError';
  }
}

/** Identity could not be asked (transport failure, timeout, 5xx). Still denies; callers that can tell it apart may retry. */
export class ApiKeyOwnershipUnavailableError extends ApiKeyRevokedError {
  constructor() {
    super('API key not found', 'auth.api_key_denied');
    this.name = 'ApiKeyOwnershipUnavailableError';
  }
}

/** Identity ownership body only. Never invent a revoke. */
export function optionalApiKeyRevoked(body: unknown): boolean | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  const raw = rec.revoked;
  if (typeof raw !== 'boolean') return undefined;
  return raw;
}

/** Walk a tRPC envelope or a bare body. Never invent a revoke. */
export function optionalApiKeyRevokedFromExchange(body: unknown): boolean | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const envelope = body as {
    result?: { data?: { json?: unknown; revoked?: unknown } };
    revoked?: unknown;
  };
  const data = envelope.result?.data?.json ?? envelope.result?.data ?? body;
  return optionalApiKeyRevoked(data);
}

/** Revoked cannot open a session. Missing stays open (no invented live-check). */
export function apiKeyIsRevoked(revoked: boolean | null | undefined): boolean {
  return revoked === true;
}

export function assertApiKeyNotRevoked(revoked: boolean | null | undefined): void {
  if (apiKeyIsRevoked(revoked)) {
    throw new ApiKeyRevokedError('API key is revoked', 'auth.api_key_revoked');
  }
}

export interface LoadApiKeyOwnershipOptions {
  readonly identityUrl: string;
  readonly apiKeyId: string;
  readonly userId: string;
  readonly identityOwnershipSecret: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Identity GET /internal/api-keys/:id. 404 / mismatch → denied.
 * Transport / non-OK (including 401/403) / parse → denied (fail-closed, not live).
 * `revoked: true` → revoked. Never invent live.
 * Returns the identity body so bind lists (IP allowlist) can be read without
 * a second store or a second GET. Schema extras are not stripped here.
 */
export async function assertIdentityApiKeyLive(options: LoadApiKeyOwnershipOptions): Promise<unknown> {
  const id = typeof options.apiKeyId === 'string' ? options.apiKeyId.trim() : '';
  if (!id) {
    throw new ApiKeyRevokedError('API key not found', 'auth.api_key_denied');
  }
  const base = options.identityUrl.replace(/\/+$/, '');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const headers = serviceAuthHeadersForBody('svc-edge', options.identityOwnershipSecret, '');
  let response: Response;
  try {
    response = await fetchFn(`${base}/internal/api-keys/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new ApiKeyOwnershipUnavailableError();
  }
  if (response.status === 404) {
    throw new ApiKeyRevokedError('API key not found', 'auth.api_key_denied');
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 408 || response.status === 429) throw new ApiKeyOwnershipUnavailableError();
    throw new ApiKeyRevokedError('API key not found', 'auth.api_key_denied');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiKeyOwnershipUnavailableError();
  }
  const parsed = apiKeyOwnershipSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiKeyRevokedError('API key not found', 'auth.api_key_denied');
  }
  if (parsed.data.id !== id || parsed.data.userId !== options.userId) {
    throw new ApiKeyRevokedError('API key not found', 'auth.api_key_denied');
  }
  assertApiKeyNotRevoked(parsed.data.revoked);
  return body;
}
