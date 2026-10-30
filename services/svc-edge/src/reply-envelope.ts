import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AUTH_ERRORS_PATH } from '@intafaced/contracts/auth-errors';
import { refusalCopy } from './user-copy.js';

/**
 * What every reply from the front door carries (DV-errors-01, RC-developer-03).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HEADERS — on every reply, every path, every status
 *
 *   · `x-request-id`: the edge's own id for this request, a random UUID. It is a
 *     support handle, not a secret and not an idempotency key, and it holds no
 *     user data. The edge never adopts a caller's id (`requestIdHeader: false`):
 *     an id a client could choose is an id a client could collide with someone
 *     else's call in our logs. The same id goes upstream as `x-request-id`,
 *     replacing anything the caller sent under that name.
 *   · `x-server-received` / `x-server-sent`: unix milliseconds from this
 *     process's clock, read when the request arrived (the first hook) and when
 *     the reply is serialised. Sent is never before received. Millisecond
 *     resolution only: the pair tells an integrator how much of their latency
 *     is ours, which they could already estimate from the round trip; it is not
 *     precise enough to time a comparison.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ERROR BODY — every JSON object error under `/api/*`
 *
 *   · An edge refusal (anything this process answered itself) gets `requestId`
 *     (the header's value), a `docs` link when it has none, a human `message`
 *     beside the older `error` string (never a bare code), and an `edge.` code.
 *   · A THROWN error (Fastify's error-handler shape, with `statusCode` in the
 *     body) whose code is not already `edge.*` is renamed: oversize body
 *     `edge.body_too_large`, unsupported media type
 *     `edge.unsupported_media_type`, anything else `edge.internal_error` (5xx)
 *     or `edge.request_invalid` (4xx). Its own code and message (an
 *     `ERR_INVALID_URL`, a `token.invalid`, a stack-ish sentence) go to the log
 *     only, the body gets a catalogue sentence, and `statusCode` is dropped. A
 *     code the edge sends on purpose (`account_frozen`, `PermissionDenied`,
 *     `auth.csrf_origin_required`) is never renamed: it is not thrown.
 *   · A proxied service error gets `requestId` and nothing else. The service
 *     owns its body: its code, its message, its field list. The edge does not
 *     re-word what it did not decide, and it inserts the one field without
 *     re-serialising the rest, so no number in the service's body is rounded.
 *     A service body that already names a `requestId` is left untouched.
 *   · Arrays (tRPC batches), non-JSON and non-object bodies, success replies and
 *     everything outside `/api/*` (the operator plane, probes) are untouched
 *     apart from the headers.
 */

export const REQUEST_ID_HEADER = 'x-request-id' as const;
export const SERVER_RECEIVED_HEADER = 'x-server-received' as const;
export const SERVER_SENT_HEADER = 'x-server-sent' as const;

/** The response headers a browser on an allowed origin may read (`cors.ts`). Nothing else is exposed. */
export const EXPOSED_RESPONSE_HEADERS = [REQUEST_ID_HEADER, SERVER_RECEIVED_HEADER, SERVER_SENT_HEADER] as const;

/** The published error pages. Fixed paths plus the code: a link names no account and no key. */
export const ERRORS_DOCS = '/developers/errors' as const;
export const AUTH_ERRORS_DOCS = AUTH_ERRORS_PATH;

/** Fastify constructor options for the request id. Spread into `Fastify({...})` in `index.ts`. */
export const REQUEST_ID_OPTIONS = {
  genReqId: (): string => randomUUID(),
  requestIdHeader: false,
} as const;

/** Codes whose page is the authentication and permission catalogue (DV-errors-02). */
const AUTH_CODE = /^(edge\.api_key_|edge\.authority_|account_frozen$)/;

/** Fastify's own refusals, in the edge's words. Any other framework code becomes `edge.request_invalid`. */
const FRAMEWORK_CODES: Readonly<Record<string, string>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'edge.body_too_large',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'edge.unsupported_media_type',
};

/** A code we put in a URL fragment. Our codes are lowercase dotted words; anything else is not linked by name. */
const LINKABLE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export function docsFor(code: string | undefined): string {
  if (!code || !LINKABLE.test(code)) return ERRORS_DOCS;
  return `${AUTH_CODE.test(code) ? AUTH_ERRORS_DOCS : ERRORS_DOCS}#${code}`;
}

function plainObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** The pay door's tRPC-shaped refusal keeps its link under `error.data.docs`; lift that one rather than a generic page. */
function nestedDocs(body: Record<string, unknown>): string | undefined {
  const error = body.error;
  if (!error || typeof error !== 'object') return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const docs = (data as { docs?: unknown }).docs;
  return typeof docs === 'string' ? docs : undefined;
}

/** A dotted code standing where a sentence should be (an uncatalogued `userCopy` renders the key itself). */
const CODE_LIKE = /^[A-Za-z_]+(\.[A-Za-z0-9_]+)+$/;

function sentence(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !CODE_LIKE.test(value);
}

/** What a renamed thrown error said, for the log only. */
export interface RenamedError {
  readonly code: string | undefined;
  readonly message: string | undefined;
}

/** An error body the edge itself answered with: completed into the one shape. Returns the text unchanged when it is not a JSON object. */
export function completeEdgeErrorBody(
  text: string,
  input: { requestId: string; status: number; onRenamed?: (original: RenamedError) => void },
): string {
  const body = plainObject(text);
  if (!body) return text;
  const rawCode = typeof body.code === 'string' ? body.code : undefined;
  // Fastify's error handler serialises a thrown error with `statusCode` in the body; a reply the edge
  // sends on purpose never carries one.
  const thrown = typeof body.statusCode === 'number';
  let code = rawCode;
  let renamed = false;
  if (thrown && !rawCode?.startsWith('edge.')) {
    code =
      (rawCode !== undefined ? FRAMEWORK_CODES[rawCode] : undefined) ??
      (input.status >= 500 ? 'edge.internal_error' : 'edge.request_invalid');
    renamed = true;
  } else if (rawCode === undefined && (body.error === undefined || typeof body.error === 'string')) {
    // No code at all. tRPC-shaped edge bodies (`error` is an object) keep their dialect and get no top-level code.
    code = input.status >= 500 ? 'edge.internal_error' : 'edge.request_invalid';
  }
  const out: Record<string, unknown> = { ...body };
  if (thrown) delete out.statusCode;
  if (code !== undefined) out.code = code;
  if (renamed) {
    input.onRenamed?.({ code: rawCode, message: typeof body.message === 'string' ? body.message : undefined });
    // A thrown error's own words may describe our internals; the client gets the catalogue sentence.
    out.message = refusalCopy(code, input.status);
    out.error = out.message;
  } else if (!sentence(out.message)) {
    out.message = sentence(body.error) ? body.error : refusalCopy(code, input.status);
  }
  if (typeof out.docs !== 'string') out.docs = nestedDocs(body) ?? docsFor(code);
  out.requestId = input.requestId;
  return JSON.stringify(out);
}

/**
 * A proxied service error: `requestId` inserted, every other byte as the service sent it.
 * A body that already has a `requestId`, or is not a JSON object, comes back unchanged.
 */
export function stampProxiedErrorBody(text: string, requestId: string): string {
  const body = plainObject(text);
  if (!body || Object.hasOwn(body, 'requestId')) return text;
  const end = text.lastIndexOf('}');
  if (end < 0) return text;
  const field = `"requestId":${JSON.stringify(requestId)}`;
  const separator = Object.keys(body).length === 0 ? '' : ',';
  return `${text.slice(0, end)}${separator}${field}${text.slice(end)}`;
}

const PROXIED = Symbol('edge.proxied');
const RECEIVED = Symbol('edge.received');

type Marked = FastifyRequest & { [PROXIED]?: true; [RECEIVED]?: number };

/** The proxy calls this before it relays an upstream answer, so the body is treated as the service's, not ours. */
export function markProxied(req: FastifyRequest): void {
  (req as Marked)[PROXIED] = true;
}

function isApiPath(url: string): boolean {
  const pathname = url.split('?')[0] ?? url;
  return pathname === '/api' || pathname.startsWith('/api/');
}

function isJson(contentType: unknown): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return typeof value === 'string' && /^application\/json\b/i.test(value);
}

/**
 * Register FIRST, before CORS: the received time is read in the first `onRequest` hook, and this hook
 * only records it — it never answers, so it cannot change what the CORS ordering protects.
 */
export function registerReplyEnvelope(app: FastifyInstance, clock: () => number = Date.now): void {
  app.addHook('onRequest', async (req) => {
    (req as Marked)[RECEIVED] = clock();
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const marked = req as Marked;
    const received = marked[RECEIVED] ?? clock();
    const requestId = String(req.id);
    reply.header(REQUEST_ID_HEADER, requestId);
    reply.header(SERVER_RECEIVED_HEADER, String(received));

    let out = payload;
    if (reply.statusCode >= 400 && typeof payload === 'string' && isApiPath(req.url) && isJson(reply.getHeader('content-type'))) {
      out = marked[PROXIED]
        ? stampProxiedErrorBody(payload, requestId)
        : completeEdgeErrorBody(payload, {
            requestId,
            status: reply.statusCode,
            onRenamed: (original) => req.log.warn({ original, status: reply.statusCode }, 'edge: thrown error renamed for the client'),
          });
    }
    // Last, so the time covers the body work above. Never before received, even if the clock steps back.
    reply.header(SERVER_SENT_HEADER, String(Math.max(clock(), received)));
    return out;
  });
}
