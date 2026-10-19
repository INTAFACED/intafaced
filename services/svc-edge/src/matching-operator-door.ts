/**
 * Founder door onto svc-matching `/operator/*`.
 *
 * Sends the principal edge already verified. This is not an HMAC proxy, it
 * does not forward `authorization`, and it never POSTs `/halt-all` as a
 * service. A missing MATCHING_URL or EDGE_PRINCIPAL_SECRET is the caller's
 * 503 (`edge.matching_unwired`) before this function is constructed.
 */
import { forwardedPrincipalHeaders, type EdgeEd25519Signing } from './forward-principal-signature.js';
import type { Principal } from '@intafaced/auth';
import { resolveRequestRegion } from './geo-region.js';

export type MatchingOperatorPath =
  '/operator/in-flight' | '/operator/halt' | '/operator/halt-all' | '/operator/resume' | '/operator/resume-all';

export type MatchingOperatorCall = (
  path: MatchingOperatorPath,
  method: 'GET' | 'POST',
  principal: Principal,
  body?: unknown,
  region?: string,
) => Promise<{ status: number; body: unknown }>;

/**
 * Region bound into the principal signature. Callers pass the same
 * `resolveRequestRegion` result the `/api` proxy uses before
 * `signPrincipalHeader`. Omitted → that resolver with no request headers
 * (DEFAULT_REGION, or XX when a geo header is named but this call has none).
 */
function regionForPrincipal(region: string | undefined): string {
  if (region) return region;
  return resolveRequestRegion({
    defaultRegion: process.env.DEFAULT_REGION ?? 'XX',
    trustProxy: process.env.EDGE_TRUST_PROXY !== undefined,
    geoHeaderName: process.env.EDGE_GEO_COUNTRY_HEADER,
  }).region;
}

export function httpMatchingOperator(
  baseUrl: string,
  timeoutMs: number,
  edgePrincipalSecret: string,
  ed25519?: EdgeEd25519Signing,
): MatchingOperatorCall {
  const base = baseUrl.replace(/\/$/, '');
  return async (path, method, principal, body, region) => {
    const signedRegion = regionForPrincipal(region);
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...forwardedPrincipalHeaders(principal, { edgeSecret: edgePrincipalSecret, ed25519, region: signedRegion }),
          'x-intafaced-region': signedRegion,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } catch (err) {
      return {
        status: 502,
        body: { error: `svc-matching did not answer: ${(err as Error).message}`, code: 'edge.matching_unavailable' },
      };
    }
  };
}
