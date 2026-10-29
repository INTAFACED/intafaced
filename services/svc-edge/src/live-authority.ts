import type { Principal } from '@intafaced/auth';
import {
  currentAuthorityInputSchema,
  currentAuthorityResultSchema,
  type CurrentAuthorityInput,
  type CurrentAuthorityResult,
} from '@intafaced/contracts';
import { identityCallHeaders, type EdgeS2s } from './s2s.js';
import { ApiKeyOwnershipUnavailableError, ApiKeyRevokedError, assertIdentityApiKeyLive } from './api-key-revoked.js';
import { assertApiKeyIp, optionalIpAllowlist } from './api-key-ip.js';
import { assertApiKeyOrigin, optionalOriginAllowlist } from './api-key-origin.js';
import { assertApiKeyProduct, optionalProductScopes } from './api-key-product.js';
import { assertApiKeyAccount, optionalAccountIdFromExchange } from './api-key-account.js';
import { assertKeyNotExpired, optionalExpiresAtFromExchange } from './api-key-expires.js';
import { ipAllowlistSatisfied, optionalFlag } from './api-key-request-sign.js';

type Eligible = Extract<CurrentAuthorityResult, { status: 'eligible' }>;
export type EdgeAuthorityOptions = {
  identityUrl?: string;
  identityOwnershipSecret?: string;
  /** The edge's own key. Absent leaves the identity reads on `identityOwnershipSecret` alone. */
  s2s?: EdgeS2s | undefined;
  fetch?: typeof fetch;
  clientIp?: string | null;
  origin?: string | null;
  accountId?: string | null;
  product?: string | null;
  /** True when this request presented the raw API key and identity accepted it. */
  apiKeyBearerSatisfied?: boolean;
  /**
   * Cap on the identity read. Strict (default 3000) for money, security and every write;
   * a higher cap may be passed for non-money reads. Configured in env.ts.
   */
  timeoutMs?: number;
  /**
   * How long a positive answer may be reused for the same session, at most 1000 ms and never
   * past the lease identity signed (5000 ms, `currentAuthorityResultSchema`). 0 = coalesce only.
   */
  positiveCacheMs?: number;
};

/**
 * - `eligible`: identity answered and the credential may act.
 * - `refused`: identity answered "not eligible / revoked", or the credential cannot be asked about
 *   (unconfigured, invalid subject). The caller refuses (401 downstream) as before.
 * - `unavailable`: identity could not be asked (timeout, network error, 5xx, 408, 429, malformed
 *   answer). The caller must NOT forward anonymous and must NOT sign the user out: 503, retry.
 */
export type AuthorityRead =
  | { readonly status: 'eligible'; readonly proof: Eligible }
  | { readonly status: 'refused'; readonly code?: AuthorityRefusalCode }
  | { readonly status: 'unavailable' };

/**
 * Why identity refused, when identity said so: its `denied` code, or `auth.api_key_revoked` from the key
 * ownership read. Absent when the refusal is the edge's own (a key restriction, an unconfigured read).
 * It is identity's verdict, carried so a refused key can be named (`api-key-refusal.ts`); it never widens access.
 */
export type AuthorityRefusalCode = Extract<CurrentAuthorityResult, { status: 'denied' }>['code'] | 'auth.api_key_revoked';

const REFUSED = { status: 'refused' } as const;
const UNAVAILABLE = { status: 'unavailable' } as const;

/** Identity's published revocation lease; a positive answer is never reused past it. */
export const AUTHORITY_POSITIVE_CACHE_MAX_MS = 1000;
const STRICT_TIMEOUT_MS = 3000;
const AUTHORITY_BUDGET_MS = 5000;

type Shared =
  | { status: 'eligible'; proof: Eligible; metadata: unknown }
  | { status: 'refused'; code?: AuthorityRefusalCode }
  | { status: 'unavailable' };

const inFlight = new Map<string, Promise<Shared>>();
const positive = new Map<string, { until: number; value: Extract<Shared, { status: 'eligible' }> }>();

/** Test hook: forget coalesced and cached reads. */
export function resetEdgeAuthorityState(): void {
  inFlight.clear();
  positive.clear();
}

function cacheKey(principal: Principal, base: string, timeoutMs: number): string {
  const credential = principal.kid ? `api_key:${principal.kid.toLowerCase()}` : `session:${principal.sid.toLowerCase()}`;
  return `${base}|${principal.userId.toLowerCase()}|${credential}|${principal.sub_account?.toLowerCase() ?? ''}|${timeoutMs}`;
}

/** One identity read per session per burst; per-request key checks run on the shared answer. */
export async function readEdgeAuthority(principal: Principal, options: EdgeAuthorityOptions): Promise<AuthorityRead> {
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
      return REFUSED;
    base = url.href.replace(/\/+$/, '');
  } catch {
    return REFUSED;
  }
  const secret = options.identityOwnershipSecret!;
  const subject = currentAuthorityInputSchema.safeParse({
    userId: principal.userId.toLowerCase(),
    credential: principal.kid
      ? { kind: 'api_key', apiKeyId: principal.kid.toLowerCase() }
      : { kind: 'session', sessionId: principal.sid.toLowerCase() },
    ...(principal.sub_account ? { subAccountId: principal.sub_account.toLowerCase() } : {}),
  });
  if (!subject.success) return REFUSED;

  const timeoutMs = options.timeoutMs ?? STRICT_TIMEOUT_MS;
  const cacheMs = Math.max(0, Math.min(options.positiveCacheMs ?? 0, AUTHORITY_POSITIVE_CACHE_MAX_MS));
  const key = cacheKey(principal, base, timeoutMs);

  let shared: Shared | undefined;
  const hit = positive.get(key);
  if (hit) {
    if (hit.until > Date.now() && Date.parse(hit.value.proof.leaseExpiresAt) > Date.now()) shared = hit.value;
    else positive.delete(key);
  }
  if (!shared) {
    let flight = inFlight.get(key);
    if (!flight) {
      flight = fetchShared(principal, base, secret, subject.data, timeoutMs, options.fetch, options.s2s).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, flight);
    }
    shared = await flight;
    if (shared.status === 'eligible' && cacheMs > 0) {
      positive.set(key, { until: Date.now() + cacheMs, value: shared });
    } else if (shared.status !== 'eligible') {
      positive.delete(key);
    }
  }
  if (shared.status === 'refused') return shared.code ? { status: 'refused', code: shared.code } : REFUSED;
  if (shared.status !== 'eligible') return UNAVAILABLE;

  const proof = shared.proof;
  if (Date.parse(proof.leaseExpiresAt) <= Date.now()) return UNAVAILABLE;
  if (principal.kid) {
    try {
      const metadata = shared.metadata;
      assertApiKeyIp(optionalIpAllowlist(metadata), options.clientIp);
      if (optionalFlag(metadata, 'requireSignature', 'require_signature') && options.apiKeyBearerSatisfied !== true) return REFUSED;
      if (
        !ipAllowlistSatisfied(
          optionalFlag(metadata, 'requireNonEmptyIpAllowlist', 'require_non_empty_ip_allowlist'),
          optionalIpAllowlist(metadata),
        )
      )
        return REFUSED;
      assertApiKeyOrigin(optionalOriginAllowlist(metadata), options.origin);
      assertApiKeyProduct(optionalProductScopes(metadata) ?? [], options.product);
      assertApiKeyAccount(optionalAccountIdFromExchange(metadata), options.accountId);
      assertKeyNotExpired(optionalExpiresAtFromExchange(metadata), new Date());
    } catch {
      return REFUSED;
    }
  }
  return { status: 'eligible', proof };
}

async function fetchShared(
  principal: Principal,
  base: string,
  secret: string,
  subject: CurrentAuthorityInput,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  s2s: EdgeS2s | undefined,
): Promise<Shared> {
  const started = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Shared>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(UNAVAILABLE);
    }, timeoutMs);
  });
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
  const call = async (): Promise<Shared> => {
    try {
      const body = JSON.stringify(subject);
      let response: Response;
      try {
        const target = `${base}/trpc/accountControls.currentAuthority`;
        response = await guardedFetch(target, {
          method: 'POST',
          body,
          headers: {
            'content-type': 'application/json',
            ...identityCallHeaders(secret, s2s, { method: 'POST', target, body, contentType: 'application/json' }),
          },
        });
      } catch {
        return UNAVAILABLE;
      }
      if (!response.ok) {
        // 5xx, request timeout and throttling mean identity could not answer; any other refusal is an answer.
        return response.status >= 500 || response.status === 408 || response.status === 429 ? UNAVAILABLE : REFUSED;
      }
      let envelope: unknown;
      try {
        envelope = await response.json();
      } catch {
        return UNAVAILABLE;
      }
      const parsed = currentAuthorityResultSchema.safeParse((envelope as { result?: { data?: unknown } } | null)?.result?.data);
      if (!parsed.success) return UNAVAILABLE;
      if (parsed.data.status === 'denied') return { status: 'refused', code: parsed.data.code };
      if (parsed.data.status !== 'eligible') return REFUSED;
      const proof = parsed.data;
      if (JSON.stringify(proof.subject) !== body) return REFUSED;
      if (Date.parse(proof.leaseExpiresAt) <= Date.now()) return REFUSED;
      if (performance.now() - started >= AUTHORITY_BUDGET_MS) return UNAVAILABLE;
      let metadata: unknown;
      if (principal.kid) {
        try {
          metadata = await assertIdentityApiKeyLive({
            identityUrl: base,
            apiKeyId: principal.kid.toLowerCase(),
            userId: subject.userId,
            identityOwnershipSecret: secret,
            s2s,
            fetch: guardedFetch,
          });
        } catch (err) {
          if (err instanceof ApiKeyOwnershipUnavailableError || controller.signal.aborted) return UNAVAILABLE;
          return err instanceof ApiKeyRevokedError && err.code === 'auth.api_key_revoked'
            ? { status: 'refused', code: 'auth.api_key_revoked' }
            : REFUSED;
        }
      }
      if (performance.now() - started >= AUTHORITY_BUDGET_MS || Date.parse(proof.leaseExpiresAt) <= Date.now()) return UNAVAILABLE;
      return { status: 'eligible', proof, metadata };
    } catch {
      return UNAVAILABLE;
    }
  };
  try {
    return await Promise.race([call(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
