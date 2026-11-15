/**
 * API-key account bind at the edge session door (M01 / M05-R06).
 * Bound key + presented account must be the same id. Unbound stays open.
 * Missing account when the key is bound refuses. Never invent a bind.
 */

export class KeyAccountError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.account_required' | 'auth.account_mismatch',
  ) {
    super(message);
    this.name = 'KeyAccountError';
  }
}

/** Empty / missing is a missing account — never invent primary. */
export function optionalAccountId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length > 0 ? id : undefined;
}

/** Identity / exchange body only. Never invent a bind. */
export function optionalAccountIdFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  return optionalAccountId(rec.accountId ?? rec.account_id);
}

/** Walk a tRPC envelope or a bare body. Never invent a bind. */
export function optionalAccountIdFromExchange(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const envelope = body as {
    result?: { data?: { json?: unknown; accountId?: unknown; account_id?: unknown } };
    accountId?: unknown;
    account_id?: unknown;
  };
  const data = envelope.result?.data?.json ?? envelope.result?.data ?? body;
  return optionalAccountIdFromBody(data);
}

/** Client-presented account. Not x-intafaced-* (those are stripped). */
export function requestAccountId(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers['x-account-id'] ?? headers['X-Account-Id'] ?? headers['account-id'] ?? headers.accountId;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return optionalAccountId(value);
}

/** Bound key + presented account must be the same non-empty id. */
export function apiKeyAccountAllowed(boundAccountId: string | null | undefined, presentedAccountId: string | null | undefined): boolean {
  const bound = typeof boundAccountId === 'string' ? boundAccountId.trim() : '';
  const presented = typeof presentedAccountId === 'string' ? presentedAccountId.trim() : '';
  if (!bound || !presented) return false;
  return bound === presented;
}

/**
 * Bound key must name that account. Unbound (no bound id) stays open.
 * Bound + missing presented refuses. Never invent a bind.
 */
export function assertApiKeyAccount(boundAccountId: string | null | undefined, presentedAccountId: string | null | undefined): void {
  const bound = optionalAccountId(boundAccountId ?? undefined);
  const presented = optionalAccountId(presentedAccountId ?? undefined);
  if (!bound) return;
  if (!presented) {
    throw new KeyAccountError('accountId is required', 'auth.account_required');
  }
  if (!apiKeyAccountAllowed(bound, presented)) {
    throw new KeyAccountError('API key is not bound to this account', 'auth.account_mismatch');
  }
}

/**
 * The routes a sub-account-bound key reaches (DV-sub-accounts-01: "the key reaches only that account"). Its token
 * carries the sub-account, but most services still answer for the signed-in person's own account, so a bound key
 * is let through only where the service reads the token's sub-account; everywhere else it is refused here, before
 * anything is forwarded. Widen this only together with the service that answers for the sub-account.
 */
const SUB_ACCOUNT_KEY_ROUTES: ReadonlyArray<{ readonly method: string; readonly path: string }> = [
  { method: 'GET', path: '/api/v1/account/balance' },
];

/** Whether a sub-account-bound key may make this request. No request named: refused. */
export function subAccountKeyRouteAllowed(request: { method: string; path: string } | undefined): boolean {
  if (!request) return false;
  const path = request.path.split('?')[0] ?? '';
  const method = request.method.toUpperCase();
  return SUB_ACCOUNT_KEY_ROUTES.some((route) => route.method === method && route.path === path);
}
