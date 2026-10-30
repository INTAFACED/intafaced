import 'server-only';
import type { AdminSessionConfig, FounderSession } from '@/lib/founder-session';

/**
 * Server-side hop from a console desk to an owning service through svc-edge, always as the signed-in founder.
 *
 * Used by the support, notify, pay-halts and approval desks. It sends the founder's OWN access token and never
 * substitutes a deployment credential, so the service sees (and records) the person at the keyboard.
 *
 * Every non-ok outcome is a named kind. For a MUTATION, `unavailable.uncertain` says whether the request may
 * have reached the service: a refusal with a status is a definite answer, a timeout or a 5xx is not, and the
 * desk must say "outcome unknown, read the state" instead of "failed".
 */

export interface FounderCallContext {
  readonly session: FounderSession;
  readonly config: AdminSessionConfig;
}

export type DeskModule =
  | 'identity'
  | 'trade'
  | 'pay'
  | 'support'
  | 'notify'
  | 'bank'
  | 'p2p'
  | 'academy'
  | 'market'
  | 'agents'
  | 'quant'
  | 'mining'
  | 'token'
  | 'protocol'
  | 'indexer'
  | 'dex'
  | 'campaigns';

/** A module a console action can call that has no desk reads: svc-ops, reached at `/api/ops`. */
export type CallModule = DeskModule | 'ops';

export interface ServiceRefusal {
  /** Typed code from `error.data.cause.code`, or from a `[code]` suffix in the message, or null. */
  readonly code: string | null;
  readonly message: string;
  readonly status: number;
}

export type FounderCallResult<T> =
  | { readonly kind: 'ok'; readonly data: T; readonly requestId: string | null }
  | { readonly kind: 'forbidden'; readonly refusal: ServiceRefusal; readonly requestId: string | null }
  | { readonly kind: 'refused'; readonly refusal: ServiceRefusal; readonly requestId: string | null }
  | { readonly kind: 'not_built'; readonly procedure: string; readonly requestId: string | null }
  | { readonly kind: 'unavailable'; readonly uncertain: boolean; readonly requestId: string | null }
  | { readonly kind: 'invalid'; readonly requestId: string | null };

export type FounderCallFailure<T> = Exclude<FounderCallResult<T>, { kind: 'ok' }>;

const TIMEOUT_MS = 8_000;
const CODE_IN_MESSAGE = /\[([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\]\s*$/;

interface TrpcErrorBody {
  error?: {
    message?: unknown;
    json?: { message?: unknown; data?: { cause?: { code?: unknown }; code?: unknown } };
    data?: { cause?: { code?: unknown }; code?: unknown };
  };
}

function unwrapError(body: unknown): { code: string | null; message: string; trpcCode: string | null } {
  const err = (body as TrpcErrorBody | null)?.error;
  const inner = err?.json ?? err;
  const data = (err?.json?.data ?? err?.data) as { cause?: { code?: unknown }; code?: unknown } | undefined;
  const message = typeof inner?.message === 'string' ? inner.message : typeof err?.message === 'string' ? err.message : '';
  const cause = data?.cause?.code;
  // Identity appends the typed code to its message as `[action_approval.not_approved]`.
  const suffix = CODE_IN_MESSAGE.exec(message)?.[1] ?? null;
  return {
    code: typeof cause === 'string' ? cause : suffix,
    message,
    trpcCode: typeof data?.code === 'string' ? data.code : null,
  };
}

function unwrapData(body: unknown): { found: boolean; data: unknown } {
  if (!body || typeof body !== 'object' || !('result' in body)) return { found: false, data: null };
  const result = (body as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || !('data' in result)) return { found: false, data: null };
  const data = (result as { data: unknown }).data;
  return { found: true, data: data && typeof data === 'object' && 'json' in data ? (data as { json: unknown }).json : data };
}

export interface FounderCallOptions {
  /**
   * Send an empty object as the input of a GET instead of leaving the input out. A procedure whose input schema is an object
   * (every field optional) refuses a missing input, so asking for "all of it" needs an explicit `{}`.
   */
  readonly sendEmptyInput?: boolean;
  /** A shorter bound than the default, for a read that sits in front of every page or write (maintenance mode). */
  readonly timeoutMs?: number;
}

export async function founderCall<T>(
  ctx: FounderCallContext,
  module: CallModule,
  procedure: string,
  method: 'GET' | 'POST',
  input: unknown,
  parse: (raw: unknown) => T | null,
  options: FounderCallOptions = {},
): Promise<FounderCallResult<T>> {
  return edgeCall({ edgeUrl: ctx.config.edgeUrl, token: ctx.session.accessToken }, module, procedure, method, input, parse, options);
}

/**
 * The same hop with a named bearer. Only the treasury hops (`treasuryOps` in lib/accounts/holds-server.ts and lib/recon-alerts/treasury.ts,
 * `restoreTreasuryCall` in lib/restore/treasury.ts) pass anything but the founder's own token: the treasury credential, for the
 * procedures a founder session can never carry (`admin:treasury`).
 */
export async function edgeCall<T>(
  target: { readonly edgeUrl: string; readonly token: string },
  module: CallModule,
  procedure: string,
  method: 'GET' | 'POST',
  input: unknown,
  parse: (raw: unknown) => T | null,
  options: FounderCallOptions = {},
): Promise<FounderCallResult<T>> {
  const empty = typeof input === 'object' && input !== null && Object.keys(input as object).length === 0;
  const hasInput = input !== undefined && input !== null && (!empty || options.sendEmptyInput === true);
  const query = method === 'GET' && hasInput ? `?input=${encodeURIComponent(JSON.stringify(input))}` : '';
  let response: Response;
  try {
    response = await fetch(`${target.edgeUrl}/api/${module}/trpc/${procedure}${query}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${target.token}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(input ?? {}) } : {}),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
  } catch {
    // The request may or may not have arrived. For a read that is harmless; for a write it is "unknown".
    return { kind: 'unavailable', uncertain: method === 'POST', requestId: null };
  }
  const requestId = response.headers.get('x-request-id');
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const { code, message, trpcCode } = unwrapError(body);
    const refusal: ServiceRefusal = { code, message, status: response.status };
    if (response.status === 501 || trpcCode === 'NOT_IMPLEMENTED' || (response.status === 404 && /no procedure/i.test(message))) {
      return { kind: 'not_built', procedure, requestId };
    }
    if (response.status === 401 || response.status === 403) return { kind: 'forbidden', refusal, requestId };
    if (response.status >= 500 && code === null) return { kind: 'unavailable', uncertain: method === 'POST', requestId };
    return { kind: 'refused', refusal, requestId };
  }

  const unwrapped = unwrapData(body);
  if (!unwrapped.found) return { kind: 'invalid', requestId };
  const parsed = parse(unwrapped.data);
  return parsed === null ? { kind: 'invalid', requestId } : { kind: 'ok', data: parsed, requestId };
}

/** Build a parser from a zod-style schema (anything with `safeParse`). */
export function parseWith<T>(schema: {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}): (raw: unknown) => T | null {
  return (raw) => {
    const result = schema.safeParse(raw);
    return result.success ? result.data : null;
  };
}
