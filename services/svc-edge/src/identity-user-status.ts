/**
 * Identity user status at the HTTP session door (M17).
 * Disabled (frozen/closed) cannot open a NEW session. Active proceeds.
 * Consume GET /internal/account/:userId — no second store. Never invent active.
 */

import { accountStateSchema } from '@intafaced/contracts';
import { identityCallHeaders, type EdgeS2s } from './s2s.js';
import { assertUserNotFrozen, KeyUserStatusError, optionalUserStatus } from './api-key-user-status.js';

export { KeyUserStatusError };

export type IdentityAccountStatus = 'active' | 'frozen' | 'closed';

/** Identity account body only. Never invent a status. */
export function optionalAccountStatus(body: unknown): IdentityAccountStatus | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  return optionalUserStatus({ status: rec.status });
}

/** Walk a tRPC envelope or a bare body. Never invent a status. */
export function optionalAccountStatusFromExchange(body: unknown): IdentityAccountStatus | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const envelope = body as {
    result?: { data?: { json?: unknown; status?: unknown } };
    status?: unknown;
  };
  const data = envelope.result?.data?.json ?? envelope.result?.data ?? body;
  return optionalAccountStatus(data);
}

export interface LoadAccountStatusOptions {
  readonly identityUrl: string;
  readonly userId: string;
  readonly identityOwnershipSecret: string;
  /** The edge's own key. Absent leaves the call on `identityOwnershipSecret` alone. */
  readonly s2s?: EdgeS2s | undefined;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Identity GET /internal/account/:userId. 404 / mismatch → frozen (not live).
 * Transport / non-OK (including 401/403) / parse → frozen (fail-closed, not live).
 * `status: frozen|closed` → cannot open. Never invent active.
 */
export async function assertIdentityUserActive(options: LoadAccountStatusOptions): Promise<void> {
  const id = typeof options.userId === 'string' ? options.userId.trim() : '';
  if (!id) {
    throw new KeyUserStatusError('Account is frozen', 'auth.account_frozen');
  }
  const base = options.identityUrl.replace(/\/+$/, '');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const target = `${base}/internal/account/${encodeURIComponent(id)}`;
  const headers = identityCallHeaders(options.identityOwnershipSecret, options.s2s, { method: 'GET', target, body: '', contentType: '' });
  let response: Response;
  try {
    response = await fetchFn(target, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new KeyUserStatusError('Account is frozen', 'auth.account_frozen');
  }
  if (response.status === 404) {
    throw new KeyUserStatusError('Account is frozen', 'auth.account_frozen');
  }
  if (!response.ok) {
    throw new KeyUserStatusError('Account is frozen', 'auth.account_frozen');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new KeyUserStatusError('Account is frozen', 'auth.account_frozen');
  }
  const parsed = accountStateSchema.safeParse(body);
  if (!parsed.success) {
    throw new KeyUserStatusError('Account is frozen', 'auth.account_frozen');
  }
  if (parsed.data.userId !== id) {
    throw new KeyUserStatusError('Account is frozen', 'auth.account_frozen');
  }
  assertUserNotFrozen(parsed.data.status);
}
