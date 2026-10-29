import { hasScope, type Principal, type Scope } from '@intafaced/auth';
import { EDGE_API_KEY_RATE_BUCKET, EDGE_RATE_COST } from './hardening.js';
import { userCopy } from './user-copy.js';

/**
 * ONE key / scope / quota / sandbox plane in front of trade and pay (§9).
 *
 * Keys stay `identity.apikeys` — this file does not mint, store, or revoke.
 * Dialects stay two (ADR 2026-08-07-pay-public-api-law): trade speaks CCXT on
 * `/api/v1`, pay speaks the pay/tRPC dialect on `/api/pay`. Scope refuse uses
 * each door's existing vocabulary (`scope.denied`). Quota refuse uses the
 * existing edge throttle code. Do not add a third error taxonomy here.
 *
 * Interactive sessions (no `kid`) keep service-level `scopedProcedure`. This
 * plane gates long-lived API keys only.
 */

export const GATEWAY_KEY_PLANE = 'identity.apikeys' as const;

/** Two dialects. A third key here is the failure this row exists to refuse. */
export const GATEWAY_DIALECTS = {
  trade: 'ccxt',
  pay: 'pay',
} as const;

export type GatewayDoor = keyof typeof GATEWAY_DIALECTS;

export interface QuotaBucket {
  count: number;
  resetAt: number;
}

export type QuotaStore = Map<string, QuotaBucket>;

export function createQuotaStore(): QuotaStore {
  return new Map();
}

export function doorForPath(pathname: string): GatewayDoor | null {
  if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) return 'trade';
  if (pathname === '/api/trade' || pathname.startsWith('/api/trade/')) return 'trade';
  if (pathname === '/api/pay' || pathname.startsWith('/api/pay/')) return 'pay';
  return null;
}

export function requiredScopeFor(door: GatewayDoor, method: string): Scope {
  const verb = method.toUpperCase();
  const write = verb !== 'GET' && verb !== 'HEAD' && verb !== 'OPTIONS';
  if (door === 'trade') return write ? 'trade:write' : 'trade:read';
  return write ? 'pay:write' : 'pay:read';
}

export type GatewayDecision = { allow: true; sandbox: boolean } | { allow: false; status: number; body: Record<string, unknown> };

/** The published permission-to-endpoint table. A fixed path: it names no account, so it tells a caller nothing about one. */
export const PERMISSION_TABLE_DOCS = '/developers/permissions' as const;

function scopeMessage(scope: Scope): string {
  return `Scope "${scope}" is required`;
}

/**
 * Trade door: existing CCXT PermissionDenied. Pay door: existing tRPC FORBIDDEN.
 * Both carry `docs`, the link to the permission table.
 */
export function scopeRefuseBody(door: GatewayDoor, scope: Scope): Record<string, unknown> {
  const message = scopeMessage(scope);
  if (door === 'trade') {
    return { code: 'PermissionDenied', message, intafacedCode: 'scope.denied', docs: PERMISSION_TABLE_DOCS };
  }
  return {
    error: {
      message,
      data: { code: 'FORBIDDEN', httpStatus: 403, intafacedCode: 'scope.denied', docs: PERMISSION_TABLE_DOCS },
    },
  };
}

/** Same code the IP throttle already emits — one quota vocabulary, not a third. */
export function quotaRefuseBody(retryAfterSeconds: number): Record<string, unknown> {
  return {
    error: userCopy('edge.rate_limited'),
    code: 'edge.rate_limited',
    retryAfterSeconds,
    remaining: 0,
    bucket: EDGE_API_KEY_RATE_BUCKET,
    cost: EDGE_RATE_COST,
  };
}

export function takeQuota(
  store: QuotaStore,
  kid: string,
  now: number,
  max: number,
  windowMs: number,
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const existing = store.get(kid);
  if (!existing || existing.resetAt <= now) {
    store.set(kid, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (existing.count >= max) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  existing.count += 1;
  return { ok: true };
}

export function sandboxOf(principal: Principal | null): boolean {
  return principal?.key_env === 'sandbox';
}

export type KeyEnvironment = 'live' | 'sandbox';

/**
 * Doors with a sandbox backing. Only pay has one (its card-sandbox rail); trade has no sandbox book, so a sandbox key
 * at a trade door is refused rather than served from live.
 */
export const SANDBOX_BACKED_DOORS: ReadonlySet<GatewayDoor> = new Set<GatewayDoor>(['pay']);

/** `EDGE_SANDBOX_HOSTS` (comma list of Host header values) as a set. Blank: no sandbox host, so every sandbox key refuses. */
export function parseSandboxHosts(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The environment a request addresses, from its Host header. Anything not named a sandbox host is live. */
export function hostEnvironment(host: string | null | undefined, sandboxHosts: ReadonlySet<string>): KeyEnvironment {
  const h = (host ?? '').trim().toLowerCase();
  return h && sandboxHosts.has(h) ? 'sandbox' : 'live';
}

/** Edge vocabulary, the same shape as the quota refusal: a sentence and one code. */
export function envMismatchBody(): Record<string, unknown> {
  return { error: userCopy('env.mismatch'), code: 'env.mismatch' };
}

/**
 * Decide whether an API-key caller may pass this door.
 *
 * Anonymous callers and interactive sessions skip the scope and quota checks — they are not this plane — but a
 * session at a sandbox host is refused like any live principal there. Paths other than trade/pay return allow —
 * there is no "data" door yet.
 */
export function decideGateway(input: {
  pathname: string;
  method: string;
  principal: Principal | null;
  quota: QuotaStore;
  now: number;
  max: number;
  windowMs: number;
  /** The request's Host header. */
  host?: string | null;
  /** Parsed `EDGE_SANDBOX_HOSTS`. Empty: no sandbox host. */
  sandboxHosts?: ReadonlySet<string>;
}): GatewayDecision {
  const door = doorForPath(input.pathname);
  const sandbox = sandboxOf(input.principal);
  if (!door) return { allow: true, sandbox };

  const verb = input.method.toUpperCase();
  if (verb === 'OPTIONS') return { allow: true, sandbox };

  // Environment first, before any scope or quota work. The key's environment is fixed at creation and read from the
  // verified principal; a session is live. The request's environment is its host. They must match, and a sandbox key
  // is only served by a door with a sandbox backing, never from live.
  if (input.principal) {
    const keyEnv: KeyEnvironment = sandbox ? 'sandbox' : 'live';
    const hostEnv = hostEnvironment(input.host, input.sandboxHosts ?? new Set());
    if (keyEnv !== hostEnv || (keyEnv === 'sandbox' && !SANDBOX_BACKED_DOORS.has(door))) {
      return { allow: false, status: 403, body: envMismatchBody() };
    }
  }

  const kid = input.principal?.kid;
  if (!kid) return { allow: true, sandbox };

  const needed = requiredScopeFor(door, verb);
  if (!hasScope(input.principal!.scopes, needed)) {
    return { allow: false, status: 403, body: scopeRefuseBody(door, needed) };
  }

  const quota = takeQuota(input.quota, kid, input.now, input.max, input.windowMs);
  if (!quota.ok) {
    return { allow: false, status: 429, body: quotaRefuseBody(quota.retryAfterSeconds) };
  }

  return { allow: true, sandbox };
}
