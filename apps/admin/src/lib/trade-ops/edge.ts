import 'server-only';
import type { AdminSessionConfig, FounderSession } from '@/lib/founder-session';
import { BLOCKERS } from './blockers';
import { ok, refused, unknown, type Outcome } from './outcome';

/**
 * The one hop from the trade desk to svc-edge. Server only: the founder's access token never reaches the browser.
 *
 * Every answer becomes an Outcome:
 *   · 2xx, body parsed          → ok
 *   · a service refusal (4xx/5xx with a code) → refused, with the service's own code and message
 *   · 404/405 on a route that is not mounted  → refused, edge.no_route
 *   · network error or timeout  → unknown (an action may or may not have happened; never retried here)
 */

export interface TradeCtx {
  readonly session: FounderSession;
  readonly config: AdminSessionConfig;
}

export interface EdgeSpec<T> {
  readonly method: 'GET' | 'POST';
  /** Path on svc-edge, e.g. /api/v1/admin/orders/open or /admin/kill-switches. */
  readonly path: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  /** Return null when the body is not the shape this desk understands. */
  readonly parse: (raw: unknown) => T | null;
  readonly timeoutMs?: number;
}

const TIMEOUT_MS = 6_000;

/** Pull the service's own code/message out of the assorted error envelopes (REST, tRPC, edge). */
export function errorParts(body: unknown, status: number): { code: string; message: string } {
  const root = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const err = (root.error && typeof root.error === 'object' ? root.error : {}) as Record<string, unknown>;
  const json = (err.json && typeof err.json === 'object' ? err.json : err) as Record<string, unknown>;
  const data = (json.data && typeof json.data === 'object' ? json.data : {}) as Record<string, unknown>;
  const pick = (...v: unknown[]) => v.find((x): x is string => typeof x === 'string' && x.length > 0);
  // tRPC puts the service's own code in data.intafacedCode (auth) or data.cause.code; data.code is only the tRPC class.
  const cause = (data.cause && typeof data.cause === 'object' ? data.cause : {}) as Record<string, unknown>;
  const code =
    pick(
      root.intafacedCode,
      json.intafacedCode,
      root.code,
      json.code,
      data.appCode,
      data.intafacedCode,
      cause.code,
      data.code,
      typeof root.error === 'string' ? root.error : undefined,
    ) ?? `http.${status}`;
  // svc-edge's operator doors put the sentence in `error` next to a `code`; without a `code`, `error` is itself the code.
  const sentence = typeof root.error === 'string' && typeof root.code === 'string' ? root.error : undefined;
  const message = pick(root.message, json.message, root.detail, root.reason, sentence) ?? `The service answered ${status} (${code}).`;
  return { code, message };
}

/** tRPC wraps successes as { result: { data: { json } } } or { result: { data } }. */
export function unwrapTrpc(body: unknown): unknown {
  if (body && typeof body === 'object' && 'result' in body) {
    const data = (body as { result?: { data?: unknown } }).result?.data;
    return data && typeof data === 'object' && 'json' in data ? (data as { json: unknown }).json : data;
  }
  return body;
}

export async function edgeCall<T>(ctx: TradeCtx, spec: EdgeSpec<T>): Promise<Outcome<T>> {
  const url = new URL(`${ctx.config.edgeUrl}${spec.path}`);
  for (const [k, v] of Object.entries(spec.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const at = () => new Date().toISOString();
  let res: Response;
  try {
    res = await fetch(url, {
      method: spec.method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${ctx.session.accessToken}`,
        ...(spec.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(spec.method === 'POST' ? { body: JSON.stringify(spec.body ?? {}) } : {}),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(spec.timeoutMs ?? TIMEOUT_MS),
    });
  } catch {
    return unknown(
      spec.method === 'POST'
        ? 'The connection ended before svc-edge confirmed the result. The action may or may not have been applied: read the state again before repeating it.'
        : 'svc-edge did not answer in time. The figures below are not current.',
      at(),
    );
  }
  const body: unknown = await res.json().catch(() => null);
  // svc-edge says `outcome: unknown` when its own upstream call timed out: the action may or may not have happened.
  if (body && typeof body === 'object' && (body as { outcome?: unknown }).outcome === 'unknown') {
    const parts = errorParts(body, res.status);
    return unknown(`${parts.message} (${parts.code}). The result is not known: read the state again before repeating it.`, at());
  }
  if (res.ok) {
    const parsed = spec.parse(unwrapTrpc(body));
    return parsed === null
      ? refused(
          'trade_ops.unexpected_shape',
          'The service answered with a shape this desk does not recognise, so nothing is shown rather than a guess.',
          502,
          null,
          at(),
        )
      : ok(parsed, at());
  }
  if (res.status === 404 || res.status === 405) {
    const parts = errorParts(body, res.status);
    if (parts.code === `http.${res.status}` || parts.code === 'not_found')
      return refused('edge.no_route', `svc-edge has no route for ${spec.method} ${spec.path}.`, res.status, null, at());
  }
  if (res.status === 401 || res.status === 403) {
    const parts = errorParts(body, res.status);
    return refused(parts.code, parts.message, res.status, null, at());
  }
  const parts = errorParts(body, res.status);
  return refused(parts.code, parts.message, res.status, null, at());
}

/** tRPC procedure on a module: GET ?input=… for queries, POST body for mutations. */
export function trpcSpec<T>(
  module: 'trade' | 'identity',
  procedure: string,
  kind: 'query' | 'mutation',
  input: unknown,
  parse: (raw: unknown) => T | null,
): EdgeSpec<T> {
  const path = `/api/${module}/trpc/${procedure}`;
  return kind === 'query'
    ? { method: 'GET', path, query: { input: JSON.stringify(input ?? {}) }, parse }
    : { method: 'POST', path, body: input, parse };
}

export { BLOCKERS };
