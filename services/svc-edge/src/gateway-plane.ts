import { hasScope, type Principal, type Scope } from '@intafaced/auth';
import type { KeyRateLimit, RateLimitReason, RouteCost } from '@intafaced/contracts/api-rate-limits';
import { EDGE_API_KEY_RATE_BUCKET, EDGE_RATE_COST } from './hardening.js';
import { routeCost, type KeyBuckets } from './rate-bucket.js';
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

/** What the key's bucket said about an allowed call, for the `x-ratelimit-*` headers. */
export interface KeyMetered {
  readonly limit: number;
  readonly remaining: number;
  readonly cost: number;
  /** Whole seconds until the key's bucket is full again. */
  readonly resetSeconds: number;
}

export type GatewayDecision =
  | { allow: true; sandbox: boolean; metered?: KeyMetered }
  | {
      allow: false;
      status: number;
      body: Record<string, unknown>;
      limited?: { reason: RateLimitReason; limit: number; cost: number; retryAfterSeconds: number | null };
    };

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

/**
 * Same code the IP throttle already emits — one quota vocabulary, not a third. `reason` says which limit refused it
 * (`global`: the key's bucket is spent; `endpoint`: the route costs more than the key's whole burst). The request id
 * is added on the way out (`reply-envelope.ts`).
 */
export function quotaRefuseBody(
  retryAfterSeconds: number | null,
  reason: RateLimitReason = 'global',
  cost: number = EDGE_RATE_COST,
): Record<string, unknown> {
  return {
    error: userCopy('edge.rate_limited'),
    code: 'edge.rate_limited',
    reason,
    retryAfterSeconds,
    remaining: 0,
    bucket: EDGE_API_KEY_RATE_BUCKET,
    cost,
    docs: RATE_LIMITS_DOCS,
  };
}

/** The published limits page: tiers, costs and the backoff guidance. */
export const RATE_LIMITS_DOCS = '/developers/rate-limits' as const;

/** A key's limit or a route's cost that the owner has not set: nothing is metered on a guess, so nothing passes. */
export function limitsUnsetBody(code: 'edge.limits_unset' | 'edge.cost_unset' | 'edge.api_key_bearer_required'): Record<string, unknown> {
  return { error: userCopy(code), code, docs: RATE_LIMITS_DOCS };
}

export function sandboxOf(principal: Principal | null): boolean {
  return principal?.key_env === 'sandbox';
}

export type KeyEnvironment = 'live' | 'sandbox';

/**
 * Doors with a sandbox backing. Only pay has one (its card-sandbox rail); trade has no sandbox book, so a sandbox key
 * at a trade door is refused rather than served from live. Any other path has no sandbox backing either.
 */
export const SANDBOX_BACKED_DOORS: ReadonlySet<GatewayDoor> = new Set<GatewayDoor>(['pay']);

/** One `EDGE_SANDBOX_HOSTS` entry: a host name, IPv4 or bracketed IPv6, an optional port. No scheme, path or wildcard. */
export const SANDBOX_HOST_ENTRY = /^(\[[0-9a-f:.]+\]|[a-z0-9-]+(\.[a-z0-9-]+)*\.?)(:\d{1,5})?$/i;

/** True when every comma-separated entry of `EDGE_SANDBOX_HOSTS` is a `SANDBOX_HOST_ENTRY`. Blank is valid. */
export function sandboxHostsValid(raw: string | undefined): boolean {
  return (raw ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .every((h) => SANDBOX_HOST_ENTRY.test(h));
}

/**
 * A Host header value in one spelling: trimmed, case-folded, a trailing root dot dropped and a default port (80, 443)
 * dropped, so `Sandbox.Example.:443` and `sandbox.example` name the same environment.
 */
export function normalizeHost(raw: string | null | undefined): string {
  const h = (raw ?? '').trim().toLowerCase();
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(h);
  if (!m) return h;
  const name = m[1]!.replace(/\.$/, '');
  const port = m[2];
  return port && port !== '80' && port !== '443' ? `${name}:${port}` : name;
}

/** `EDGE_SANDBOX_HOSTS` (comma list of Host header values) as a set. Blank: no sandbox host, so every sandbox key refuses. */
export function parseSandboxHosts(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((h) => normalizeHost(h))
      .filter(Boolean),
  );
}

/** The environment a request addresses, from its Host header. Anything not named a sandbox host is live. */
export function hostEnvironment(host: string | null | undefined, sandboxHosts: ReadonlySet<string>): KeyEnvironment {
  const h = normalizeHost(host);
  return h && sandboxHosts.has(h) ? 'sandbox' : 'live';
}

const ENV_MISMATCH_MESSAGE = 'This key belongs to the other environment';

/**
 * The refusal in the dialect of the door it happens at, like the scope refusal: CCXT PermissionDenied on trade, tRPC
 * FORBIDDEN on pay, the edge's own `{ error, code }` anywhere else. All three carry `env.mismatch`.
 */
export function envMismatchBody(door: GatewayDoor | null): Record<string, unknown> {
  if (door === 'trade') {
    return { code: 'PermissionDenied', message: ENV_MISMATCH_MESSAGE, intafacedCode: 'env.mismatch' };
  }
  if (door === 'pay') {
    return {
      error: { message: ENV_MISMATCH_MESSAGE, data: { code: 'FORBIDDEN', httpStatus: 403, intafacedCode: 'env.mismatch' } },
    };
  }
  return { error: userCopy('env.mismatch'), code: 'env.mismatch' };
}

/** The `env.mismatch` code read from any of the three refusal bodies. */
export function envMismatchCodeOf(body: Record<string, unknown>): string | undefined {
  const error = body.error as { data?: { intafacedCode?: string } } | undefined;
  return (body.intafacedCode as string | undefined) ?? error?.data?.intafacedCode ?? (body.code as string | undefined);
}

/**
 * Decide whether a caller may pass.
 *
 * The environment rule runs first for every principal on every path (CORS preflight aside): the key's environment,
 * fixed at creation, against the host's. A session is live, so a session at a sandbox host is refused too. Then API
 * keys at the trade/pay doors take the scope and quota checks; anonymous callers and sessions skip those (they are
 * not this plane), and paths other than trade/pay pass — there is no "data" door yet.
 */
export function decideGateway(input: {
  pathname: string;
  method: string;
  principal: Principal | null;
  /** Every key's token bucket on this replica (`rate-bucket.ts`). */
  buckets: KeyBuckets;
  /** The key's limit from identity's exchange; null or absent: no limit is set, so a key call is refused. */
  keyRateLimit?: KeyRateLimit | null | undefined;
  /** The owner's per-route cost table (`EDGE_RATE_ROUTE_COSTS`). A call it names no cost for is refused. */
  costs: readonly RouteCost[];
  now: number;
  /** The request's Host header. */
  host?: string | null;
  /** Parsed `EDGE_SANDBOX_HOSTS`. Empty: no sandbox host. */
  sandboxHosts?: ReadonlySet<string>;
}): GatewayDecision {
  const door = doorForPath(input.pathname);
  const sandbox = sandboxOf(input.principal);
  const verb = input.method.toUpperCase();
  if (verb === 'OPTIONS') return { allow: true, sandbox };

  // Environment first, before any scope or quota work. The key's environment is fixed at creation and read from the
  // verified principal; a session is live. The request's environment is its host. They must match, and a sandbox key
  // is only served by a door with a sandbox backing, never from live.
  if (input.principal) {
    const keyEnv: KeyEnvironment = sandbox ? 'sandbox' : 'live';
    const hostEnv = hostEnvironment(input.host, input.sandboxHosts ?? new Set());
    if (keyEnv !== hostEnv || (sandbox && !(door && SANDBOX_BACKED_DOORS.has(door)))) {
      return { allow: false, status: 403, body: envMismatchBody(door) };
    }
  }
  if (!door) return { allow: true, sandbox };

  const kid = input.principal?.kid;
  if (!kid) return { allow: true, sandbox };

  const needed = requiredScopeFor(door, verb);
  if (!hasScope(input.principal!.scopes, needed)) {
    return { allow: false, status: 403, body: scopeRefuseBody(door, needed) };
  }

  // The key's limit is read only when the key itself is presented; its exchanged access token sent instead carries none.
  if (input.keyRateLimit === undefined) return { allow: false, status: 401, body: limitsUnsetBody('edge.api_key_bearer_required') };
  const limit = input.keyRateLimit;
  if (!limit) return { allow: false, status: 503, body: limitsUnsetBody('edge.limits_unset') };
  const cost = routeCost(input.costs, verb, input.pathname);
  if (cost === null) return { allow: false, status: 503, body: limitsUnsetBody('edge.cost_unset') };
  const taken = input.buckets.take(kid, input.principal!.userId, limit, cost, input.now);
  if (!taken.ok) {
    return {
      allow: false,
      status: 429,
      body: quotaRefuseBody(taken.retryAfterSeconds, taken.reason, cost),
      limited: { reason: taken.reason, limit: taken.burst, cost, retryAfterSeconds: taken.retryAfterSeconds },
    };
  }

  return { allow: true, sandbox, metered: { limit: taken.burst, remaining: taken.remaining, cost, resetSeconds: taken.fullInSeconds } };
}
