import { AuthError, verifyAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import { identityCallHeaders, type EdgeS2s } from './s2s.js';
import { forwardedPrincipalHeaders } from './forward-principal-signature.js';
import { normalizeIp } from './request-client-ip.js';
import { assertKeyNotExpired, optionalExpiresAtFromExchange, KeyExpiresError } from './api-key-expires.js';
import { assertApiKeyAccount, optionalAccountIdFromExchange, requestAccountId, KeyAccountError } from './api-key-account.js';
import { assertUserNotFrozen, optionalUserStatusFromExchange, KeyUserStatusError } from './api-key-user-status.js';
import { assertApiKeyOrigin, optionalOriginAllowlistFromExchange, KeyOriginError } from './api-key-origin.js';
import { assertApiKeyIp, optionalIpAllowlist, optionalIpAllowlistFromExchange, KeyIpError } from './api-key-ip.js';
import { hashBody, ipAllowlistSatisfied, optionalFlag, readRequestSignHeaders, type RequestSignMaterial } from './api-key-request-sign.js';
import { assertApiKeyProduct, optionalProductScopesFromExchange, requestProduct, KeyProductError } from './api-key-product.js';
import { readEdgeAuthority } from './live-authority.js';
import {
  ACCOUNT_FROZEN,
  API_KEY_DENIED,
  API_KEY_EXPIRED,
  apiKeyRefusalFromAuthorityCode,
  apiKeyRefusalFromIdentityCode,
  apiKeyShapeOk,
  identityErrorCode,
  isIdentityKeyVerdict,
  presentedScopeShapeOk,
  requestSignShapeOk,
  type ApiKeyRefusal,
} from './api-key-refusal.js';

/**
 * THE EDGE (§9) — where a bearer token becomes a principal.
 *
 * Every mounted service reads `ctx.principal` and never re-derives it, and
 * `createEdgeContext` will only believe a principal that carries a valid
 * signature. Nothing in the platform produced that signature. The result, found
 * by audit: **every `scopedProcedure` in the OS refused every caller**, because
 * svc-identity issued a JWT that opened no door.
 *
 * This module is the join. It is the only place in the system that turns proof
 * of identity into authority, so its failure modes are the platform's.
 *
 * ── The rule that matters more than the happy path ──────────────────────────
 *
 * `x-intafaced-*` headers are the edge's vocabulary, not the caller's. A client
 * that sends `x-intafaced-principal` is either confused or attacking, and the
 * two are indistinguishable from here.
 *
 * So the headers are STRIPPED FIRST, unconditionally, before any decision about
 * whether to add our own. Not overwritten — stripped. The difference matters on
 * every path where we decide NOT to set them: an anonymous request, a failed
 * verification, an expired token. Overwriting only protects the success case,
 * which is the one case that was never at risk.
 *
 * `region` is included in that strip, and that is the subtle one. It drives the
 * jurisdiction matrix (§9) — which modules a caller may reach at all. A client
 * that could set its own region could select its own regulator.
 */

/** Headers a client may never supply. Stripped before anything else happens. */
export const RESERVED_HEADER_PREFIX = 'x-intafaced-';

export interface ExchangeResult {
  /** Headers to forward upstream. Never includes anything the client sent. */
  headers: Record<string, string>;
  /** Null for an anonymous request — which is a valid outcome, not an error. */
  principal: Principal | null;
  /** Why a token was refused. Null when accepted or when none was offered. */
  rejected: 'malformed' | 'expired' | 'invalid' | 'unavailable' | null;
  /**
   * Set only when a platform API key (`ifc_…`) was presented and refused. The proxy answers it at the edge and
   * forwards nothing (`api-key-refusal.ts`). An interactive JWT never sets it: a refused session still goes up
   * as anonymous, so it can reach `auth.refresh`.
   */
  apiKeyRefusal?: ApiKeyRefusal;
}

export interface ExchangeOptions {
  tokens: TokenConfig;
  /** Shared with every mounted service. Signs the principal we forward. */
  edgeSecret: string;
  /**
   * When set, the forwarded principal is signed with this Ed25519 key (and carries `iat` and a short expiry) instead of
   * the shared secret. Unset keeps the shared-secret form until every receiver verifies with the public key.
   * `maxLifetimeSeconds` has no default; it comes from `EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS`.
   */
  ed25519?: { privateKey: string; maxLifetimeSeconds: number };
  /**
   * Resolved server-side — never from the request. Today a single configured
   * value; when geo-IP lands it resolves per request. Either way the caller
   * does not get a vote.
   */
  region: string;
  /**
   * Base URL of svc-identity (no trailing slash). Used only when the bearer
   * is a long-lived API key (`ifc_…`) so we can call public `apiKeys.exchange`
   * without giving the edge `INTERNAL_SERVICE_SECRET`.
   */
  identityUrl?: string;
  /**
   * Server-resolved client IP (Fastify `req.ip` or a trusted first hop).
   * Never taken from a client-supplied x-forwarded-for. Forwarded to
   * identity on `ifc_…` exchange so a bound key refuses a foreign IP.
   */
  clientIp?: string | null;
  /** Injected in tests. */
  fetch?: typeof globalThis.fetch;
  /** Actual route module resolved by the server, rather than a caller-selected product. */
  resolvedProduct?: string;
  /** Cap on the per-request identity authority read (see `EDGE_AUTHORITY_*_TIMEOUT_MS`). Default strict 3000 ms. */
  authorityTimeoutMs?: number;
  /** Reuse of a positive authority answer for the same session, at most 1000 ms. Default 0 (coalesce only). */
  authorityPositiveCacheMs?: number;
  /**
   * Dedicated read key matching identity's IDENTITY_EDGE_AUTHORITY_SECRET.
   * Missing configuration refuses authenticated forwarding.
   */
  identityOwnershipSecret?: string;
  /** The edge's own key. Absent leaves the identity calls on `identityOwnershipSecret` alone. */
  s2s?: EdgeS2s | undefined;
  /**
   * The merchant request the edge is about to forward. Present so an opted-in
   * key can be signed over these bytes. Absent on callers that only exchange
   * a bearer (tests). Unsigned keys ignore it.
   */
  request?: { method: string; path: string; body?: Buffer | string | Uint8Array | null };
}

/**
 * Hop-by-hop headers (RFC 7230 §6.1) plus the request identity headers the
 * edge must rewrite itself.
 *
 * Until this list was complete, the comment above claimed the class while only
 * `connection` (plus `host` / `content-length`) was stripped — an audit finding
 * (`docs/audit/2026-08-08-svc-edge.md` #7). `transfer-encoding`, `te`,
 * `trailer`, `upgrade`, `keep-alive` and the proxy-auth pair were forwarded.
 * Undici may reject some of those outbound, but a safety control that relies on
 * the outbound client to paper over a leaky filter is not a control.
 *
 * `host` is not hop-by-hop in the RFC sense; it is stripped because the
 * upstream's host must be the edge's own choice, never the caller's.
 * `content-length` is stripped because the proxy may re-encode the body and a
 * stale length would lie.
 *
 * `x-forwarded-origin` is stripped here, then re-set from the real `Origin`
 * in `exchangePrincipal`. Identity's `apiKeys.exchange` reads
 * `origin ?? x-forwarded-origin` for domain_whitelist. A client-supplied
 * value would let a stolen browser key pick its own allowed origin.
 *
 * `x-forwarded-for` / `x-real-ip` are stripped the same way, then re-set
 * from `ExchangeOptions.clientIp` (server-resolved). Identity's API key IP
 * allowlist fails closed on a missing IP when the list is bound. A client-
 * supplied value would let a stolen key pick its own allowed address.
 */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'x-forwarded-origin',
  'x-forwarded-for',
  'x-real-ip',
]);

/** Browser `Origin` only. Never `x-forwarded-origin` — that header is ours to write. */
export function requestOrigin(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.origin ?? headers.Origin;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Strip every reserved header, whatever its case. */
export function stripReserved(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith(RESERVED_HEADER_PREFIX)) continue;
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    // The upstream has no use for the bearer token and should never see it —
    // a service that can read a token is a service that can replay it.
    if (lower === 'authorization') continue;
    if (value === undefined) continue;
    out[lower] = Array.isArray(value) ? (value[0] ?? '') : value;
  }
  return out;
}

function bearerFrom(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

/**
 * Platform API keys are `ifc_` + base64url and never contain `.`.
 * Access JWTs are three base64 segments separated by dots — never confuse them.
 */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith('ifc_') && !token.includes('.');
}

/** What identity's key exchange gave back, when it opened the key. */
export interface ApiKeyExchanged {
  accessToken: string;
  expiresAt?: Date;
  accountId?: string;
  status?: string;
  originAllowlist?: string[];
  ipAllowlist?: string[];
  productScopes?: string[];
  requireSignature?: boolean;
  requireNonEmptyIpAllowlist?: boolean;
}

/**
 * The exchange's three outcomes.
 *
 * `refused` is identity's verdict on the key: a refusal carrying one of the verdict codes
 * (`isIdentityKeyVerdict`). `unavailable` is everything else: identity not answering (network, timeout, 5xx,
 * 408, 429), an unreadable success, and any refusal without a verdict code — a 404 for a path, a 400 for a body
 * the edge built, a service-authentication refusal. Those are the edge's own setup failing, not the caller's
 * key, so the caller is told to retry (503) instead of being told its key is bad.
 */
export type ApiKeyExchangeOutcome =
  | { readonly kind: 'opened'; readonly exchanged: ApiKeyExchanged }
  | { readonly kind: 'refused'; readonly identityCode: string }
  | { readonly kind: 'unavailable' };

/**
 * Call identity's public exchange for the short-lived JWT.
 * Named account uses `exchangeApiKeyForAccount` (bound key must match).
 * Named product uses `exchangeApiKeyForProduct` (bound key must list it).
 * Unbound / missing account+product keeps `apiKeys.exchange`.
 */
/** Identity did not answer in a way that decides anything about the key. */
function identityUnavailable(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export async function exchangeApiKeyOutcome(
  key: string,
  identityUrl: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  origin?: string | null,
  clientIp?: string | null,
  accountId?: string | null,
  product?: string | null,
  requestSign?: RequestSignMaterial,
  identityOwnershipSecret?: string,
  s2s?: EdgeS2s,
): Promise<ApiKeyExchangeOutcome> {
  const base = identityUrl.replace(/\/$/, '');
  const presented = typeof accountId === 'string' && accountId.trim().length > 0 ? accountId.trim() : undefined;
  const namedProduct = typeof product === 'string' && product.trim().length > 0 ? product.trim() : undefined;
  const path = presented ? '/trpc/exchangeApiKeyForAccount' : namedProduct ? '/trpc/exchangeApiKeyForProduct' : '/trpc/apiKeys.exchange';
  // Identity accepts the signed request field only from a service-authenticated edge.
  // Without the dedicated key, omit the field so a public body cannot carry it.
  const attest = Boolean(requestSign && identityOwnershipSecret);
  const request = attest ? { request: requestSign } : {};
  // Identity's exchange procedures take their input as the plain tRPC body, with no transformer envelope: a `{ json }`
  // wrapper reads as a missing key there (400), and every key bearer then reached the service anonymous.
  const payload = presented
    ? { key, accountId: presented, ...request }
    : namedProduct
      ? { key, product: namedProduct, ...request }
      : { key, ...request };
  const payloadText = JSON.stringify(payload);
  const target = `${base}${path}`;
  let response: Response;
  try {
    response = await fetchFn(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
        ...(clientIp ? { 'x-forwarded-for': clientIp, 'x-real-ip': clientIp } : {}),
        ...(namedProduct ? { 'x-product': namedProduct } : {}),
        ...(attest
          ? identityCallHeaders(identityOwnershipSecret!, s2s, {
              method: 'POST',
              target,
              body: payloadText,
              contentType: 'application/json',
            })
          : {}),
      },
      body: payloadText,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { kind: 'unavailable' };
  }
  if (!response.ok) {
    if (identityUnavailable(response.status)) return { kind: 'unavailable' };
    let refusal: unknown;
    try {
      refusal = await response.json();
    } catch {
      refusal = undefined;
    }
    const identityCode = identityErrorCode(refusal);
    return identityCode !== undefined && isIdentityKeyVerdict(identityCode) ? { kind: 'refused', identityCode } : { kind: 'unavailable' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: 'unavailable' };
  }

  const envelope = body as {
    result?: { data?: { json?: { accessToken?: string }; accessToken?: string } };
    accessToken?: string;
  };
  const accessToken = envelope.result?.data?.json?.accessToken ?? envelope.result?.data?.accessToken ?? envelope.accessToken;
  // A 200 with no token is identity saying something we cannot read: not a verdict on the key.
  if (typeof accessToken !== 'string' || accessToken.length === 0) return { kind: 'unavailable' };
  const expiresAt = optionalExpiresAtFromExchange(body);
  const boundAccountId = optionalAccountIdFromExchange(body);
  const status = optionalUserStatusFromExchange(body);
  const originAllowlist = optionalOriginAllowlistFromExchange(body);
  const ipAllowlist = optionalIpAllowlistFromExchange(body);
  const productScopes = optionalProductScopesFromExchange(body);
  const data = envelope.result?.data?.json ?? envelope.result?.data ?? body;
  const exchanged: ApiKeyExchanged = {
    accessToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(boundAccountId === undefined ? {} : { accountId: boundAccountId }),
    ...(status === undefined ? {} : { status }),
    ...(originAllowlist === undefined ? {} : { originAllowlist }),
    ...(ipAllowlist === undefined ? {} : { ipAllowlist }),
    ...(productScopes === undefined ? {} : { productScopes }),
    ...(optionalFlag(data, 'requireSignature', 'require_signature') ? { requireSignature: true } : {}),
    ...(optionalFlag(data, 'requireNonEmptyIpAllowlist', 'require_non_empty_ip_allowlist') ? { requireNonEmptyIpAllowlist: true } : {}),
  };
  return { kind: 'opened', exchanged };
}

/**
 * Exchange an inbound request's credentials for forwardable headers.
 *
 * Never throws on a bad token. A caller presenting a forged or expired token is
 * an ordinary event on a public endpoint, and it must land the request on the
 * service as ANONYMOUS rather than as a 500 — `protectedProcedure` will refuse
 * it there with the right status. Failing closed means failing quietly to
 * anonymous, not failing loudly.
 *
 * A platform API key is the exception: a refused `ifc_…` key comes back with
 * `apiKeyRefusal` set, and the proxy answers it at the edge instead of
 * forwarding anything (`api-key-refusal.ts`). Identity not answering is
 * `rejected: 'unavailable'` for a key as for a session, never a key verdict.
 */
export async function exchangePrincipal(
  headers: Record<string, string | string[] | undefined>,
  options: ExchangeOptions,
  now: Date = new Date(),
): Promise<ExchangeResult> {
  const forward = stripReserved(headers);
  forward['x-intafaced-region'] = options.region;

  const origin = requestOrigin(headers);
  if (origin) {
    forward.origin = origin;
    forward['x-forwarded-origin'] = origin;
  }

  const clientIp = normalizeIp(options.clientIp);
  if (clientIp) {
    forward['x-forwarded-for'] = clientIp;
    forward['x-real-ip'] = clientIp;
    forward['x-intafaced-client-ip'] = clientIp;
  }

  let token = bearerFrom(headers);
  if (!token) return { headers: forward, principal: null, rejected: null };
  const presentedApiKey = looksLikeApiKey(token);

  if (presentedApiKey) {
    // A key is refused at the edge, never forwarded as anonymous (`api-key-refusal.ts`).
    const refuse = (refusal: ApiKeyRefusal, rejected: 'expired' | 'invalid' = 'invalid'): ExchangeResult => ({
      headers: forward,
      principal: null,
      rejected,
      apiKeyRefusal: refusal,
    });
    if (!options.identityUrl) {
      // No identity to ask is this process's configuration, not a verdict on the caller's key.
      return { headers: forward, principal: null, rejected: 'unavailable' };
    }
    const presentedAccountId = requestAccountId(headers);
    const presentedProduct = options.resolvedProduct ?? requestProduct(headers);
    const signHeaders = readRequestSignHeaders(headers);
    const requestSign: RequestSignMaterial | undefined =
      options.request && signHeaders.timestamp && signHeaders.nonce && signHeaders.signature
        ? {
            method: options.request.method,
            path: options.request.path,
            timestamp: signHeaders.timestamp,
            nonce: signHeaders.nonce,
            bodyHash: hashBody(options.request.body),
            signature: signHeaders.signature,
          }
        : undefined;
    // A shape identity's schema refuses is answered here, with no identity call: identity's answer would be a
    // code-less 400, which must not be readable as an identity outage (`api-key-refusal.ts`). The signed
    // request is checked only when it will be sent (`attest` in `exchangeApiKeyOutcome`).
    if (
      !apiKeyShapeOk(token) ||
      !presentedScopeShapeOk(presentedAccountId, options.resolvedProduct === undefined ? presentedProduct : undefined) ||
      (requestSign && options.identityOwnershipSecret && !requestSignShapeOk(requestSign))
    ) {
      return refuse(API_KEY_DENIED);
    }
    const outcome = await exchangeApiKeyOutcome(
      token,
      options.identityUrl,
      options.fetch,
      origin,
      clientIp,
      presentedAccountId,
      presentedProduct,
      requestSign,
      options.identityOwnershipSecret,
      options.s2s,
    );
    if (outcome.kind === 'unavailable') {
      return { headers: forward, principal: null, rejected: 'unavailable' };
    }
    if (outcome.kind === 'refused') {
      const refusal = apiKeyRefusalFromIdentityCode(outcome.identityCode);
      return refuse(refusal, refusal === API_KEY_EXPIRED ? 'expired' : 'invalid');
    }
    const exchanged = outcome.exchanged;
    if (exchanged.requireSignature && !requestSign) {
      return refuse(API_KEY_DENIED);
    }
    if (!ipAllowlistSatisfied(exchanged.requireNonEmptyIpAllowlist === true, exchanged.ipAllowlist)) {
      return refuse(API_KEY_DENIED);
    }
    try {
      assertKeyNotExpired(exchanged.expiresAt, now);
      assertApiKeyAccount(exchanged.accountId, presentedAccountId);
      assertUserNotFrozen(exchanged.status);
      assertApiKeyOrigin(exchanged.originAllowlist, origin);
      assertApiKeyIp(exchanged.ipAllowlist, clientIp);
      assertApiKeyProduct(exchanged.productScopes, presentedProduct);
    } catch (err) {
      if (err instanceof KeyExpiresError) {
        return err.code === 'auth.api_key_expired' ? refuse(API_KEY_EXPIRED, 'expired') : refuse(API_KEY_DENIED);
      }
      if (err instanceof KeyUserStatusError) {
        return refuse(ACCOUNT_FROZEN);
      }
      if (err instanceof KeyAccountError || err instanceof KeyOriginError || err instanceof KeyIpError || err instanceof KeyProductError) {
        return refuse(API_KEY_DENIED);
      }
      throw err;
    }
    token = exchanged.accessToken;
  }

  // From here a key has been opened by identity. A refusal is named only from identity's own code; without
  // one it is the one denied answer: the edge cannot name a reason identity did not give.
  const keyRefused = presentedApiKey ? { apiKeyRefusal: API_KEY_DENIED } : {};

  let principal: Principal;
  try {
    principal = await verifyAccessToken(token, options.tokens);
  } catch (err) {
    const code = err instanceof AuthError ? err.code : 'token.invalid';
    const rejected = code === 'token.expired' ? 'expired' : code === 'token.malformed' ? 'malformed' : 'invalid';
    return { headers: forward, principal: null, rejected, ...keyRefused };
  }

  if (principal.expiresAt.getTime() <= now.getTime()) {
    return { headers: forward, principal: null, rejected: 'expired', ...keyRefused };
  }

  const read = await readEdgeAuthority(principal, {
    ...options,
    timeoutMs: options.authorityTimeoutMs,
    positiveCacheMs: options.authorityPositiveCacheMs,
    clientIp,
    origin,
    accountId: requestAccountId(headers),
    product: options.resolvedProduct ?? requestProduct(headers),
    apiKeyBearerSatisfied: presentedApiKey,
  });
  // Identity answered "no" -> refuse as before. Identity could not be asked -> say so; the caller
  // answers 503 and keeps the session instead of forwarding anonymous.
  if (read.status === 'unavailable') return { headers: forward, principal: null, rejected: 'unavailable' };
  if (read.status !== 'eligible') {
    const named = presentedApiKey ? { apiKeyRefusal: apiKeyRefusalFromAuthorityCode(read.code) } : {};
    return { headers: forward, principal: null, rejected: 'invalid', ...named };
  }
  const authority = read.proof;
  // Identity's current tier may have changed since this JWT was minted.
  principal = { ...principal, tier: authority.account.kycTier };

  Object.assign(
    forward,
    forwardedPrincipalHeaders(principal, { edgeSecret: options.edgeSecret, ed25519: options.ed25519, region: options.region, now }),
  );

  return { headers: forward, principal, rejected: null };
}
