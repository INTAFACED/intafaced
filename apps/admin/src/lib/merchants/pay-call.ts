import 'server-only';
import {
  NO_INPUT,
  replyAccepted,
  type ProcedureInput,
  type ProcedureOutput,
  type ProcedureRecord,
  type TrpcTransport,
} from '@intafaced/contracts/procedure';
import type { AdminSessionConfig, FounderSession } from '@/lib/founder-session';

/**
 * Server-side hop from the Merchants panel to svc-pay (and identity, for the
 * second-founder approval) through svc-edge, always as the signed-in founder.
 *
 * It exists next to `founderEdgeCall` because that helper throws away the
 * upstream error body, and this panel needs two things from it: `pay.not_built`
 * (a procedure that is stubbed on main) and the typed refusal code (so a
 * refusal is explained in plain English, never shown as a status number).
 *
 * Nothing here caches. Nothing here invents data: every non-ok outcome is a
 * named kind, and the pages render each one.
 */

export interface PayCallContext {
  readonly session: FounderSession;
  readonly config: AdminSessionConfig;
}

export interface PayRefusal {
  /** Typed code from `error.data.cause.code`, or null when the service named none. */
  readonly code: string | null;
  /** The service's own sentence. Never shown without going through the plain-English map. */
  readonly message: string;
  readonly status: number;
}

export type PayFailure =
  | { readonly kind: 'not_built'; readonly procedure: string; readonly requestId: string | null }
  | { readonly kind: 'forbidden'; readonly requestId: string | null }
  | { readonly kind: 'not_found'; readonly requestId: string | null }
  | { readonly kind: 'refused'; readonly refusal: PayRefusal; readonly requestId: string | null }
  | { readonly kind: 'unavailable'; readonly requestId: string | null }
  | { readonly kind: 'invalid'; readonly requestId: string | null };

export type PayCallResult<T> = { readonly kind: 'ok'; readonly data: T } | PayFailure;

const TIMEOUT_MS = 8_000;

interface TrpcErrorBody {
  error?: {
    message?: unknown;
    code?: unknown;
    json?: { message?: unknown; data?: { cause?: { code?: unknown }; httpStatus?: unknown; code?: unknown } };
    data?: { cause?: { code?: unknown }; httpStatus?: unknown; code?: unknown };
  };
}

function unwrapError(body: unknown): { code: string | null; message: string; trpcCode: string | null } {
  const err = (body as TrpcErrorBody | null)?.error;
  const inner = err?.json ?? err;
  const data = (err?.json?.data ?? err?.data) as { cause?: { code?: unknown }; code?: unknown } | undefined;
  const cause = data?.cause?.code;
  const message = typeof inner?.message === 'string' ? inner.message : typeof err?.message === 'string' ? err.message : '';
  return {
    code: typeof cause === 'string' ? cause : null,
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

export async function payCall<T>(
  ctx: PayCallContext,
  procedure: string,
  method: 'GET' | 'POST',
  input: unknown,
  parse: (raw: unknown) => T | null,
  module: 'pay' | 'identity' = 'pay',
): Promise<PayCallResult<T>> {
  const query = method === 'GET' ? `?input=${encodeURIComponent(JSON.stringify(input ?? {}))}` : '';
  let response: Response;
  try {
    response = await fetch(`${ctx.config.edgeUrl}/api/${module}/trpc/${procedure}${query}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${ctx.session.accessToken}`,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(input ?? {}) } : {}),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { kind: 'unavailable', requestId: null };
  }
  const requestId = response.headers.get('x-request-id');
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const { code, message, trpcCode } = unwrapError(body);
    const notBuilt =
      response.status === 501 ||
      trpcCode === 'NOT_IMPLEMENTED' ||
      code === 'pay.not_built' ||
      message.startsWith('pay.not_built') ||
      (response.status === 404 && /no procedure/i.test(message));
    if (notBuilt) return { kind: 'not_built', procedure, requestId };
    if (code === 'pay.merchant_not_found') return { kind: 'not_found', requestId };
    if (response.status === 401 || response.status === 403) {
      // A typed refusal (for example a live-mode registry write) is explained; a bare 401/403 is the founder gate.
      return code !== null && !code.startsWith('operator.') && code !== 'mfa.required'
        ? { kind: 'refused', refusal: { code, message, status: response.status }, requestId }
        : { kind: 'forbidden', requestId };
    }
    if (response.status >= 500 && code === null) return { kind: 'unavailable', requestId };
    return { kind: 'refused', refusal: { code, message, status: response.status }, requestId };
  }

  const unwrapped = unwrapData(body);
  if (!unwrapped.found) return { kind: 'invalid', requestId };
  const parsed = parse(unwrapped.data);
  return parsed === null ? { kind: 'invalid', requestId } : { kind: 'ok', data: parsed };
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

type PayRecord = ProcedureRecord & TrpcTransport & { readonly service: 'svc-pay'; readonly module: 'pay' };

/**
 * `payCall` through the call's record: the path and method come from the record, the input is checked by it before it
 * leaves, and the answer is parsed by `record.output` and the record's `accept` checks. An input the record refuses is
 * never sent: it is refused here as the service refuses it, a 400 with no code.
 */
export async function payRecordCall<R extends PayRecord>(
  ctx: PayCallContext,
  record: R,
  input: ProcedureInput<R>,
): Promise<PayCallResult<ProcedureOutput<R>>> {
  let checked: unknown;
  if (record.input !== NO_INPUT) {
    const parsed = record.input.safeParse(input);
    if (!parsed.success) return { kind: 'refused', refusal: { code: null, message: parsed.error.message, status: 400 }, requestId: null };
    checked = parsed.data;
  }
  return payCall(ctx, record.path, record.kind === 'query' ? 'GET' : 'POST', checked, (raw) => {
    const parsed = record.output.safeParse(raw);
    return parsed.success && replyAccepted(record, parsed.data) ? (parsed.data as ProcedureOutput<R>) : null;
  });
}
