import { AuthError, verifyAccessToken, type Principal, type TokenConfig } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader, EDGE_PRINCIPAL_HEADER, EDGE_SIGNATURE_HEADER } from '@intafaced/contracts';
import { normalizeIp } from './request-client-ip.js';
import { assertKeyNotExpired, optionalExpiresAtFromExchange, KeyExpiresError } from './api-key-expires.js';
import { assertApiKeyAccount, optionalAccountIdFromExchange, requestAccountId, KeyAccountError } from './api-key-account.js';
import { assertUserNotFrozen, optionalUserStatusFromExchange, KeyUserStatusError } from './api-key-user-status.js';
import { assertApiKeyOrigin, optionalOriginAllowlistFromExchange, KeyOriginError } from './api-key-origin.js';
import { assertApiKeyIp, optionalIpAllowlist, optionalIpAllowlistFromExchange, KeyIpError } from './api-key-ip.js';
import { assertApiKeyProduct, optionalProductScopesFromExchange, requestProduct, KeyProductError } from './api-key-product.js';
import { readEdgeAuthority } from './live-authority.js';

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
  rejected: 'malformed' | 'expired' | 'invalid' | null;
}

export interface ExchangeOptions {
  tokens: TokenConfig;
  /** Shared with every mounted service. Signs the principal we forward. */
  edgeSecret: string;
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
  /**
   * Dedicated read key matching identity's IDENTITY_EDGE_AUTHORITY_SECRET.
   * Missing configuration refuses authenticated forwarding.
   */
  identityOwnershipSecret?: string;
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

/**
 * Call identity's public exchange and return the short-lived JWT.
 * Named account uses `exchangeApiKeyForAccount` (bound key must match).
 * Named product uses `exchangeApiKeyForProduct` (bound key must list it).
 * Unbound / missing account+product keeps `apiKeys.exchange`. Returns null on failure.
 */
export async function exchangeApiKeyForAccessToken(
  key: string,
  identityUrl: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  origin?: string | null,
  clientIp?: string | null,
  accountId?: string | null,
  product?: string | null,
): Promise<{
  accessToken: string;
  expiresAt?: Date;
  accountId?: string;
  status?: string;
  originAllowlist?: string[];
  ipAllowlist?: string[];
  productScopes?: string[];
} | null> {
  const base = identityUrl.replace(/\/$/, '');
  const presented = typeof accountId === 'string' && accountId.trim().length > 0 ? accountId.trim() : undefined;
  const namedProduct = typeof product === 'string' && product.trim().length > 0 ? product.trim() : undefined;
  const path = presented ? '/trpc/exchangeApiKeyForAccount' : namedProduct ? '/trpc/exchangeApiKeyForProduct' : '/trpc/apiKeys.exchange';
  const payload = presented
    ? { json: { key, accountId: presented } }
    : namedProduct
      ? { json: { key, product: namedProduct } }
      : { json: { key } };
  let response: Response;
  try {
    response = await fetchFn(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
        ...(clientIp ? { 'x-forwarded-for': clientIp, 'x-real-ip': clientIp } : {}),
        ...(namedProduct ? { 'x-product': namedProduct } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  const envelope = body as {
    result?: { data?: { json?: { accessToken?: string }; accessToken?: string } };
    accessToken?: string;
  };
  const accessToken = envelope.result?.data?.json?.accessToken ?? envelope.result?.data?.accessToken ?? envelope.accessToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  const expiresAt = optionalExpiresAtFromExchange(body);
  const boundAccountId = optionalAccountIdFromExchange(body);
  const status = optionalUserStatusFromExchange(body);
  const originAllowlist = optionalOriginAllowlistFromExchange(body);
  const ipAllowlist = optionalIpAllowlistFromExchange(body);
  const productScopes = optionalProductScopesFromExchange(body);
  return {
    accessToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(boundAccountId === undefined ? {} : { accountId: boundAccountId }),
    ...(status === undefined ? {} : { status }),
    ...(originAllowlist === undefined ? {} : { originAllowlist }),
    ...(ipAllowlist === undefined ? {} : { ipAllowlist }),
    ...(productScopes === undefined ? {} : { productScopes }),
  };
}

/**
 * Exchange an inbound request's credentials for forwardable headers.
 *
 * Never throws on a bad token. A caller presenting a forged or expired token is
 * an ordinary event on a public endpoint, and it must land the request on the
 * service as ANONYMOUS rather than as a 500 — `protectedProcedure` will refuse
 * it there with the right status. Failing closed means failing quietly to
 * anonymous, not failing loudly.
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

  if (looksLikeApiKey(token)) {
    if (!options.identityUrl) {
      return { headers: forward, principal: null, rejected: 'invalid' };
    }
    const presentedAccountId = requestAccountId(headers);
    const presentedProduct = options.resolvedProduct ?? requestProduct(headers);
    const exchanged = await exchangeApiKeyForAccessToken(
      token,
      options.identityUrl,
      options.fetch,
      origin,
      clientIp,
      presentedAccountId,
      presentedProduct,
    );
    if (!exchanged) {
      return { headers: forward, principal: null, rejected: 'invalid' };
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
        return {
          headers: forward,
          principal: null,
          rejected: err.code === 'auth.api_key_expired' ? 'expired' : 'invalid',
        };
      }
      if (
        err instanceof KeyAccountError ||
        err instanceof KeyUserStatusError ||
        err instanceof KeyOriginError ||
        err instanceof KeyIpError ||
        err instanceof KeyProductError
      ) {
        return { headers: forward, principal: null, rejected: 'invalid' };
      }
      throw err;
    }
    token = exchanged.accessToken;
  }

  let principal: Principal;
  try {
    principal = await verifyAccessToken(token, options.tokens);
  } catch (err) {
    const code = err instanceof AuthError ? err.code : 'token.invalid';
    const rejected = code === 'token.expired' ? 'expired' : code === 'token.malformed' ? 'malformed' : 'invalid';
    return { headers: forward, principal: null, rejected };
  }

  if (principal.expiresAt.getTime() <= now.getTime()) {
    return { headers: forward, principal: null, rejected: 'expired' };
  }

  const authority = await readEdgeAuthority(principal, {
    ...options,
    clientIp,
    origin,
    accountId: requestAccountId(headers),
    product: options.resolvedProduct ?? requestProduct(headers),
  });
  if (!authority) return { headers: forward, principal: null, rejected: 'invalid' };
  // Identity's current tier may have changed since this JWT was minted.
  principal = { ...principal, tier: authority.account.kycTier };

  const raw = encodePrincipal(principal);
  forward[EDGE_PRINCIPAL_HEADER] = raw;
  forward[EDGE_SIGNATURE_HEADER] = signPrincipalHeader(raw, options.edgeSecret, options.region);

  return { headers: forward, principal, rejected: null };
}
