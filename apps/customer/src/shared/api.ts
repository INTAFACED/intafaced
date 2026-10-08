import { z, type ZodType } from 'zod';

export type RefusalReason =
  'unauthorized' | 'forbidden' | 'not_mounted' | 'not_supported' | 'unreachable' | 'invalid_response' | 'aborted' | 'error' | 'uncertain';
export type ApiResult<T> = { ok: true; data: T } | { ok: false; reason: RefusalReason; message: string; code?: string; status?: number };
export type RequestOptions = { signal?: AbortSignal };
export type RestOptions = RequestOptions & {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  idempotencyKey?: string;
};

const errorEnvelope = z
  .object({
    error: z
      .union([
        z.string(),
        z
          .object({
            message: z.string().optional(),
            code: z.union([z.string(), z.number()]).optional(),
            data: z.object({ code: z.string().optional(), intafacedCode: z.string().optional() }).passthrough().optional(),
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
    if (method !== 'GET' && options.canWrite && !options.canWrite())
      return { ok: false, reason: 'aborted', message: 'The account context changed. Review the action again in the current account.' };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
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
          return {
            ok: false,
            reason,
            message:
              reason === 'unreachable'
                ? 'The gateway could not reach the service. Try again when the connection returns.'
                : reason === 'uncertain'
                  ? 'The gateway did not confirm an outcome. Check the original request before trying again.'
                  : `The request was refused (${response.status}); no readable explanation was returned.`,
            status: response.status,
          };
        }
        return {
          ok: false,
          reason: method === 'GET' ? 'invalid_response' : 'uncertain',
          message:
            method === 'GET'
              ? 'The service returned an unreadable response.'
              : 'The response could not be read. Check the original request before trying again.',
          status: response.status,
        };
      }
      if (!response.ok) {
        const parsed = errorEnvelope.safeParse(body);
        const data = parsed.success ? parsed.data : undefined;
        const error = typeof data?.error === 'object' ? data.error : undefined;
        const code =
          error?.data?.intafacedCode ??
          error?.data?.code ??
          data?.code ??
          data?.name ??
          (typeof data?.error === 'string' ? data.error : undefined);
        const message = error?.message ?? data?.message ?? `The service refused this request (${response.status}).`;
        let reason: RefusalReason = 'error';
        if (response.status === 401) {
          reason = 'unauthorized';
          options.onUnauthorized?.(token);
        } else if (response.status === 403) reason = 'forbidden';
        else if (response.status === 404) reason = 'not_mounted';
        else if (response.status === 501) reason = 'not_supported';
        else if (response.status >= 500) reason = method === 'GET' ? 'unreachable' : 'uncertain';
        return { ok: false, reason, message, status: response.status, ...(code ? { code } : {}) };
      }
      const envelope = z.object({ result: z.object({ data: z.unknown() }) }).safeParse(body);
      if (!raw && !envelope.success)
        return {
          ok: false,
          reason: method === 'GET' ? 'invalid_response' : 'uncertain',
          message: 'The service response could not be verified.',
          status: response.status,
        };
      const data = schema.safeParse(raw ? body : envelope.success ? envelope.data.result.data : undefined);
      if (!data.success)
        return {
          ok: false,
          reason: method === 'GET' ? 'invalid_response' : 'uncertain',
          message: `The response could not be verified: ${data.error.issues.map((issue) => `${issue.path.join('.') || 'response'} ${issue.message}`).join('; ')}`,
          status: response.status,
        };
      return { ok: true, data: data.data };
    } catch (error) {
      if (requestOptions.signal?.aborted) return { ok: false, reason: 'aborted', message: 'Request stopped.' };
      return {
        ok: false,
        reason: method === 'GET' ? 'unreachable' : 'uncertain',
        message:
          method === 'GET'
            ? 'The service could not be reached. Try again when the connection returns.'
            : 'The connection ended before an outcome was confirmed. Check the original request before trying again.',
      };
    } finally {
      clearTimeout(timeout);
      requestOptions.signal?.removeEventListener('abort', cancel);
    }
  }
  return {
    query<T>(module: string, procedure: string, input: unknown, schema: ZodType<T>, opts: RequestOptions = {}) {
      const url = `/api/${encodeURIComponent(module)}/trpc/${encodeURIComponent(procedure)}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;
      return request(url, 'GET', schema, undefined, false, opts);
    },
    mutate<T>(module: string, procedure: string, input: unknown, schema: ZodType<T>, opts: RequestOptions = {}) {
      return request(`/api/${encodeURIComponent(module)}/trpc/${encodeURIComponent(procedure)}`, 'POST', schema, input ?? {}, false, opts);
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
