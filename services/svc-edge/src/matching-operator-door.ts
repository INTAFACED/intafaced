/**
 * Founder door onto svc-matching `/operator/*`.
 *
 * Forwards the human bearer. This is not an HMAC proxy and it never POSTs
 * `/halt-all` as a service. A missing MATCHING_URL is the caller's 503
 * (`edge.matching_unwired`) before this function is constructed.
 */

export type MatchingOperatorPath =
  '/operator/in-flight' | '/operator/halt' | '/operator/halt-all' | '/operator/resume' | '/operator/resume-all';

export type MatchingOperatorCall = (
  path: MatchingOperatorPath,
  method: 'GET' | 'POST',
  bearer: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

export function httpMatchingOperator(baseUrl: string, timeoutMs: number): MatchingOperatorCall {
  const base = baseUrl.replace(/\/$/, '');
  return async (path, method, bearer, body) => {
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: bearer,
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
