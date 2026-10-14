import { z, type ZodType } from 'zod';
import { uiMessage, type UiMessage } from './ui-copy';

export type RefusalReason =
  'unauthorized' | 'forbidden' | 'not_mounted' | 'not_supported' | 'unreachable' | 'invalid_response' | 'aborted' | 'error' | 'uncertain';
export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; reason: RefusalReason; message: string; messageCopy?: UiMessage; code?: string; status?: number };
export type RequestOptions = { signal?: AbortSignal; headers?: Record<string, string> };
export type RestOptions = RequestOptions & {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  idempotencyKey?: string;
};

/** Keep authored copy separate from opaque service explanations. The descriptor
 * also lets a mounted refusal follow a later device-language change. */
export function authoredRefusal(reason: RefusalReason, messageCopy: UiMessage, status?: number): Extract<ApiResult<never>, { ok: false }> {
  return { ok: false, reason, message: uiMessage(messageCopy), messageCopy, ...(status === undefined ? {} : { status }) };
}

const errorEnvelope = z
  .object({
    error: z
      .union([
        z.string(),
        z
          .object({
            message: z.string().optional(),
            code: z.union([z.string(), z.number()]).optional(),
            data: z
              .object({
                code: z.string().optional(),
                intafacedCode: z.string().optional(),
                cause: z.object({ code: z.string().optional() }).passthrough().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      ])
      .optional(),
    message: z.string().optional(),
    code: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export function createApiClient(
  options: {
    token?: () => string | undefined;
    canWrite?: () => boolean;
    fetch?: typeof fetch;
    onUnauthorized?: (requestToken: string | undefined) => void;
  } = {},
) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  async function request<T>(
    url: string,
    method: string,
    schema: ZodType<T>,
    input: unknown,
    raw: boolean,
    requestOptions: RequestOptions & { idempotencyKey?: string },
  ): Promise<ApiResult<T>> {
    if (requestOptions.signal?.aborted) return authoredRefusal('aborted', { key: 'beforeDispatch' });
    if (method !== 'GET' && options.canWrite && !options.canWrite()) return authoredRefusal('aborted', { key: 'accountChanged' });
    // A JSON content type on a body-less request (DELETE /orders/:id) makes Fastify answer 400 FST_ERR_CTP_EMPTY_JSON_BODY.
    const headers: Record<string, string> = input === undefined ? {} : { 'content-type': 'application/json' };
    // Caller headers first: they can never replace the credential headers set below.
    for (const [name, value] of Object.entries(requestOptions.headers ?? {})) headers[name.toLowerCase()] = value;
    delete headers.authorization;
    const token = options.token?.();
    if (token) headers.authorization = `Bearer ${token}`;
    if (requestOptions.idempotencyKey) headers['Idempotency-Key'] = requestOptions.idempotencyKey;
    const controller = new AbortController();
    const cancel = () => controller.abort(requestOptions.signal?.reason);
    if (requestOptions.signal?.aborted) cancel();
    else requestOptions.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('Request timed out')), 15_000);
    try {
      const response = await fetcher(url, {
        method,
        headers,
        credentials: 'same-origin',
        signal: controller.signal,
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      let body: unknown;
      try {
        body = JSON.parse(await response.text());
      } catch {
        if (!response.ok) {
          const reason: RefusalReason =
            response.status === 401
              ? 'unauthorized'
              : response.status === 403
                ? 'forbidden'
                : response.status === 404
                  ? 'not_mounted'
                  : response.status === 501
                    ? 'not_supported'
                    : response.status >= 500
                      ? method === 'GET'
                        ? 'unreachable'
                        : 'uncertain'
                      : 'error';
          if (reason === 'unauthorized') options.onUnauthorized?.(token);
          return authoredRefusal(
            reason,
            reason === 'unreachable'
              ? { key: 'gatewayUnreachable' }
              : reason === 'uncertain'
                ? { key: 'gatewayUncertain' }
                : { key: 'unreadableRefusal', status: response.status },
            response.status,
          );
        }
        return authoredRefusal(
          method === 'GET' ? 'invalid_response' : 'uncertain',
          { key: method === 'GET' ? 'unreadableRead' : 'unreadableWrite' },
          response.status,
        );
      }
      if (!response.ok) {
        const parsed = errorEnvelope.safeParse(body);
        const data = parsed.success ? parsed.data : undefined;
        const error = typeof data?.error === 'object' ? data.error : undefined;
        const code =
          error?.data?.intafacedCode ??
          error?.data?.cause?.code ??
          error?.data?.code ??
          data?.code ??
          data?.name ??
          (typeof data?.error === 'string' ? data.error : undefined);
        const message = error?.message ?? data?.message;
        let reason: RefusalReason = 'error';
        if (response.status === 401) {
          reason = 'unauthorized';
          options.onUnauthorized?.(token);
        } else if (response.status === 403) reason = 'forbidden';
        else if (response.status === 404) reason = 'not_mounted';
        else if (response.status === 501) reason = 'not_supported';
        else if (response.status >= 500) reason = method === 'GET' ? 'unreachable' : 'uncertain';
        return {
          ...(message === undefined
            ? authoredRefusal(reason, { key: 'serviceRefusal', status: response.status }, response.status)
            : { ok: false as const, reason, message, status: response.status }),
          ...(code ? { code } : {}),
        };
      }
      const envelope = z.object({ result: z.object({ data: z.unknown() }) }).safeParse(body);
      if (!raw && !envelope.success)
        return authoredRefusal(
          method === 'GET' ? 'invalid_response' : 'uncertain',
          { key: method === 'GET' ? 'unverifiedRead' : 'unverifiedWrite' },
          response.status,
        );
      const data = schema.safeParse(raw ? body : envelope.success ? envelope.data.result.data : undefined);
      if (!data.success)
        return authoredRefusal(
          method === 'GET' ? 'invalid_response' : 'uncertain',
          { key: method === 'GET' ? 'unverifiedRead' : 'unverifiedWrite' },
          response.status,
        );
      return { ok: true, data: data.data };
    } catch (error) {
      if (method === 'GET' && requestOptions.signal?.aborted) return authoredRefusal('aborted', { key: 'stopped' });
      return authoredRefusal(method === 'GET' ? 'unreachable' : 'uncertain', {
        key: method === 'GET' ? 'serviceUnreachable' : 'connectionUncertain',
      });
    } finally {
      clearTimeout(timeout);
      requestOptions.signal?.removeEventListener('abort', cancel);
    }
  }
  return {
    /** Client/session identity only; service permissions remain authoritative.
     * Async review checks use the same immediate guard as HTTP dispatch. */
    canWrite() {
      return options.canWrite?.() ?? true;
    },
    query<T>(module: string, procedure: string, input: unknown, schema: ZodType<T>, opts: RequestOptions = {}) {
      const url = `/api/${encodeURIComponent(module)}/trpc/${encodeURIComponent(procedure)}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;
      return request(url, 'GET', schema, undefined, false, opts);
    },
    mutate<T>(module: string, procedure: string, input: unknown, schema: ZodType<T>, opts: RequestOptions = {}) {
      return request(`/api/${encodeURIComponent(module)}/trpc/${encodeURIComponent(procedure)}`, 'POST', schema, input ?? {}, false, opts);
    },
    /** The edge's cookie doors (`/api/identity/session/refresh|logout`). The browser attaches the HttpOnly cookie itself; page code never holds the refresh token. The header is the CSRF marker the edge requires. */
    session<T>(action: 'refresh' | 'logout', schema: ZodType<T>, opts: RequestOptions = {}) {
      return request(`/api/identity/session/${action}`, 'POST', schema, {}, false, {
        ...opts,
        headers: { ...opts.headers, 'x-session-request': '1' },
      });
    },
    rest<T>(path: string, schema: ZodType<T>, opts: RestOptions = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(opts.query ?? {})) if (value !== undefined) query.set(key, String(value));
      return request(`/api/v1${path}${query.size ? `?${query}` : ''}`, opts.method ?? 'GET', schema, opts.body, true, opts);
    },
    scopedRest<T>(module: string, path: string, schema: ZodType<T>, opts: RestOptions = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(opts.query ?? {})) if (value !== undefined) query.set(key, String(value));
      return request(
        `/api/${encodeURIComponent(module)}${path}${query.size ? `?${query}` : ''}`,
        opts.method ?? 'GET',
        schema,
        opts.body,
        true,
        opts,
      );
    },
    plain<T>(module: string, path: string, schema: ZodType<T>, opts: RequestOptions = {}) {
      return request(`/api/${encodeURIComponent(module)}${path}`, 'GET', schema, undefined, true, opts);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
export function unavailable<T = never>(message: string): ApiResult<T> {
  return { ok: false, reason: 'not_supported', message };
}
