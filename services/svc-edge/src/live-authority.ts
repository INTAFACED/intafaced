import type { Principal } from '@intafaced/auth';
import {
  currentAuthorityInputSchema,
  currentAuthorityResultSchema,
  serviceAuthHeadersForBody,
  type CurrentAuthorityResult,
} from '@intafaced/contracts';
import { assertIdentityApiKeyLive } from './api-key-revoked.js';
import { assertApiKeyIp, optionalIpAllowlist } from './api-key-ip.js';
import { assertApiKeyOrigin, optionalOriginAllowlist } from './api-key-origin.js';
import { assertApiKeyProduct, optionalProductScopes } from './api-key-product.js';
import { assertApiKeyAccount, optionalAccountIdFromExchange } from './api-key-account.js';
import { assertKeyNotExpired, optionalExpiresAtFromExchange } from './api-key-expires.js';
import { ipAllowlistSatisfied, optionalFlag } from './api-key-request-sign.js';

type Eligible = Extract<CurrentAuthorityResult, { status: 'eligible' }>;

/**
 * Identity's private-read lease is at most 5000ms.
 * `currentAuthorityResultSchema` rejects a longer lease ("Private authority lease
 * must be positive and at most 5000ms"), and svc-identity sets
 * `leaseExpiresAt` to `checkedAt + 5000` (founder-controls `currentAuthority`).
 * That is the revocation SLA this edge already promises: a positive proof is
 * never reused longer than the lease, and a revoked or ineligible answer is
 * not cached at all.
 */
export const AUTHORITY_LEASE_SLA_MS = 5_000;
/** Reuse a fresh eligible proof only while the burst is still arriving. Inside the 1–2s cap, and inside the lease. */
export const AUTHORITY_POSITIVE_CACHE_MS = 1_000;
/** Money routes, security routes, and every write. Same ceiling the edge used when the cap was a literal. */
export const AUTHORITY_STRICT_TIMEOUT_MS = 3_000;
/** Non-money reads. Higher than the strict cap so a slow identity does not fail a page load that moves no value. */
export const AUTHORITY_READ_TIMEOUT_MS = 8_000;
export const AUTHORITY_RETRY_AFTER_SECONDS = 1;
export const EDGE_AUTHORITY_UNAVAILABLE = 'edge.authority_unavailable' as const;

/**
 * Modules whose public doors move value. Strict timeout on every method.
 * Same names as the money kill drill in control-plane.e2e.test.ts, plus
 * mining-pool (an edge money door on the kill surface).
 */
const MONEY_MODULES = new Set(['trade', 'pay', 'bank', 'p2p', 'token', 'market', 'agents', 'mining-pool']);

export type EdgeAuthorityOutcome =
  | { readonly status: 'eligible'; readonly proof: Eligible }
  | { readonly status: 'ineligible' }
  | { readonly status: 'unavailable' };

type SharedRead = EdgeAuthorityOutcome;

export type EdgeAuthorityOptions = {
  identityUrl?: string;
  identityOwnershipSecret?: string;
  fetch?: typeof fetch;
  clientIp?: string | null;
  origin?: string | null;
  accountId?: string | null;
  product?: string | null;
  /** True when this request presented the raw API key and identity accepted it. */
  apiKeyBearerSatisfied?: boolean;
  /**
   * Cap for this request's authority read. Money, security, and writes pass
   * the strict cap; non-money reads pass the higher cap. Default is strict.
   */
  timeoutMs?: number;
  /**
   * How long a positive proof may be reused. Default is the 1s burst cache,
   * never longer than the 5000ms lease. Tests leave this unset under Vitest
   * so a fixture session does not leak into the next case; the proxy passes
   * the production window explicitly.
   */
  positiveCacheMs?: number;
};

/**
 * Strict cap for money modules, the identity (security) module, and every write.
 * Non-money GET/HEAD use the higher read cap. Both numbers come from config at
 * the proxy; these defaults match EDGE_AUTHORITY_STRICT_TIMEOUT_MS (3000) and
 * EDGE_AUTHORITY_READ_TIMEOUT_MS (8000).
 */
export function authorityTimeoutFor(input: {
  method: string;
  module: string | null;
  strictMs?: number;
  readMs?: number;
}): number {
  const strict = input.strictMs ?? AUTHORITY_STRICT_TIMEOUT_MS;
  const read = input.readMs ?? AUTHORITY_READ_TIMEOUT_MS;
  const method = input.method.toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  const money = input.module !== null && MONEY_MODULES.has(input.module);
  const security = input.module === 'identity';
  if (!isRead || money || security) return strict;
  return read;
}

/** 503 the proxy returns when identity could not be asked. Never a 401. */
export function authorityUnavailableHttp(
  rejected: 'malformed' | 'expired' | 'invalid' | 'unavailable' | null,
): { readonly status: 503; readonly code: typeof EDGE_AUTHORITY_UNAVAILABLE; readonly retryAfterSeconds: number } | null {
  if (rejected !== 'unavailable') return null;
  return { status: 503, code: EDGE_AUTHORITY_UNAVAILABLE, retryAfterSeconds: AUTHORITY_RETRY_AFTER_SECONDS };
}

/** Operator doors throw this so a slow identity is 503, not a signed-out 401. */
export class EdgeAuthorityUnavailableError extends Error {
  readonly code = EDGE_AUTHORITY_UNAVAILABLE;
  readonly retryAfterSeconds = AUTHORITY_RETRY_AFTER_SECONDS;
  constructor() {
    super('Identity authority could not be read');
    this.name = 'EdgeAuthorityUnavailableError';
  }
}

const inflight = new Map<string, Promise<SharedRead>>();
const positive = new Map<string, { proof: Eligible; until: number }>();

/** Tests clear coalescing between cases. Production reads share a process-local map. */
export function resetEdgeAuthorityCoalescing(): void {
  inflight.clear();
  positive.clear();
}

function flightKey(principal: Principal): string {
  const userId = principal.userId.toLowerCase();
  const credential = principal.kid
    ? `api_key:${principal.kid.toLowerCase()}`
    : `session:${principal.sid.toLowerCase()}`;
  const sub = principal.sub_account ? principal.sub_account.toLowerCase() : '';
  return `${userId}|${credential}|${sub}`;
}

function refusalCode(err: unknown): string | null {
  if (!err || typeof err !== 'object' || !('code' in err)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function cacheWindow(options: EdgeAuthorityOptions): number {
  if (typeof options.positiveCacheMs === 'number') return Math.min(options.positiveCacheMs, AUTHORITY_LEASE_SLA_MS);
  if (process.env.VITEST) return 0;
  return AUTHORITY_POSITIVE_CACHE_MS;
}

function storePositive(key: string, proof: Eligible, cacheMs: number): void {
  if (cacheMs <= 0) return;
  const now = Date.now();
  const leaseEnd = Date.parse(proof.leaseExpiresAt);
  const until = Math.min(now + cacheMs, now + AUTHORITY_LEASE_SLA_MS, leaseEnd);
  if (Number.isFinite(until) && until > now) positive.set(key, { proof, until });
}

function cachedProof(key: string): Eligible | null {
  const hit = positive.get(key);
  if (!hit) return null;
  const now = Date.now();
  if (hit.until <= now || Date.parse(hit.proof.leaseExpiresAt) <= now) {
    positive.delete(key);
    return null;
  }
  return hit.proof;
}

async function raceTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T | { status: 'unavailable' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: 'unavailable' }>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve({ status: 'unavailable' });
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * One fresh identity read, shared by concurrent requests of the same session
 * only while that read is in flight. A positive proof may be reused for
 * AUTHORITY_POSITIVE_CACHE_MS. A denied, revoked, or unavailable answer is
 * not stored. Different sessions never share.
 */
export async function readEdgeAuthority(principal: Principal, options: EdgeAuthorityOptions): Promise<EdgeAuthorityOutcome> {
  let base: string;
  try {
    const url = new URL(options.identityUrl ?? '');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !options.identityOwnershipSecret?.trim() ||
      options.identityOwnershipSecret.length < 32
    )
      return { status: 'ineligible' };
    base = url.href.replace(/\/+$/, '');
  } catch {
    return { status: 'ineligible' };
  }
  const secret = options.identityOwnershipSecret!;
  const subject = currentAuthorityInputSchema.safeParse({
    userId: principal.userId.toLowerCase(),
    credential: principal.kid
      ? { kind: 'api_key', apiKeyId: principal.kid.toLowerCase() }
      : { kind: 'session', sessionId: principal.sid.toLowerCase() },
    ...(principal.sub_account ? { subAccountId: principal.sub_account.toLowerCase() } : {}),
  });
  if (!subject.success) return { status: 'ineligible' };
  const body = JSON.stringify(subject.data);
  const key = flightKey(principal);
  const timeoutMs = options.timeoutMs ?? AUTHORITY_STRICT_TIMEOUT_MS;
  const cacheMs = cacheWindow(options);
  const cached = cachedProof(key);
  const shared = cached
    ? ({ status: 'eligible', proof: cached } as const)
    : await loadShared(key, base, secret, body, timeoutMs, cacheMs, options.fetch);
  if (shared.status !== 'eligible') return shared;
  if (!principal.kid) return shared;
  try {
    const checked = await raceTimeout(applyKeyPolicy(principal, options, base, secret).then(() => shared), timeoutMs, () => undefined);
    if (checked.status !== 'eligible') return { status: 'unavailable' };
    return checked;
  } catch (err) {
    const code = refusalCode(err);
    if (code?.startsWith('auth.')) return { status: 'ineligible' };
    return { status: 'unavailable' };
  }
}

async function loadShared(
  key: string,
  base: string,
  secret: string,
  body: string,
  timeoutMs: number,
  cacheMs: number,
  fetchImpl: typeof fetch | undefined,
): Promise<SharedRead> {
  const existing = inflight.get(key);
  if (existing) return raceTimeout(existing, timeoutMs, () => undefined).then((result) => result);
  const controller = new AbortController();
  const flight = readOnce(base, secret, body, controller, fetchImpl);
  const bounded = raceTimeout(flight, timeoutMs, () => controller.abort());
  inflight.set(key, bounded);
  try {
    const shared = await bounded;
    // A late body that arrives after the cap must not be cached: the race already
    // answered unavailable, and a revoked session has to stop inside the lease.
    if (shared.status === 'eligible') storePositive(key, shared.proof, cacheMs);
    return shared;
  } finally {
    if (inflight.get(key) === bounded) inflight.delete(key);
  }
}

async function readOnce(
  base: string,
  secret: string,
  body: string,
  controller: AbortController,
  fetchImpl: typeof fetch | undefined,
): Promise<SharedRead> {
  const guardedFetch: typeof fetch = (url, init) => {
    const request = {
      ...init,
      signal: controller.signal,
      redirect: 'error' as const,
      cache: 'no-store',
      headers: { ...Object.fromEntries(new Headers(init?.headers)), 'cache-control': 'no-store' },
    };
    return (fetchImpl ?? fetch)(url, request);
  };
  try {
    const response = await guardedFetch(`${base}/trpc/accountControls.currentAuthority`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-edge', secret, body) },
    });
    // 5xx, 408, and 429 mean identity could not be asked. A 4xx such as 403 is a
    // definite refusal (the freeze door) and stays ineligible.
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) return { status: 'unavailable' };
      return { status: 'ineligible' };
    }
    const envelope: unknown = await response.json();
    const parsed = currentAuthorityResultSchema.safeParse((envelope as { result?: { data?: unknown } } | null)?.result?.data);
    if (!parsed.success) return { status: 'unavailable' };
    if (parsed.data.status === 'denied') return { status: 'ineligible' };
    if (parsed.data.status !== 'eligible') return { status: 'unavailable' };
    const proof = parsed.data;
    if (JSON.stringify(proof.subject) !== body || Date.parse(proof.leaseExpiresAt) <= Date.now()) return { status: 'unavailable' };
    return { status: 'eligible', proof };
  } catch {
    return { status: 'unavailable' };
  }
}

/** API-key policy is per request (IP, origin, product). It is not part of the shared read. */
async function applyKeyPolicy(principal: Principal, options: EdgeAuthorityOptions, base: string, secret: string): Promise<void> {
  const guardedFetch: typeof fetch = (url, init) => (options.fetch ?? fetch)(url, init);
  const metadata = await assertIdentityApiKeyLive({
    identityUrl: base,
    apiKeyId: principal.kid!.toLowerCase(),
    userId: principal.userId.toLowerCase(),
    identityOwnershipSecret: secret,
    fetch: guardedFetch,
  });
  assertApiKeyIp(optionalIpAllowlist(metadata), options.clientIp);
  if (optionalFlag(metadata, 'requireSignature', 'require_signature') && options.apiKeyBearerSatisfied !== true) {
    throw Object.assign(new Error('API key signature required'), { code: 'auth.api_key_denied' });
  }
  if (
    !ipAllowlistSatisfied(
      optionalFlag(metadata, 'requireNonEmptyIpAllowlist', 'require_non_empty_ip_allowlist'),
      optionalIpAllowlist(metadata),
    )
  ) {
    throw Object.assign(new Error('API key IP allowlist empty'), { code: 'auth.ip_not_allowed' });
  }
  assertApiKeyOrigin(optionalOriginAllowlist(metadata), options.origin);
  assertApiKeyProduct(optionalProductScopes(metadata) ?? [], options.product);
  assertApiKeyAccount(optionalAccountIdFromExchange(metadata), options.accountId);
  assertKeyNotExpired(optionalExpiresAtFromExchange(metadata), new Date());
}
