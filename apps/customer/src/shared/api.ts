import {
  replyAccepted,
  type ProcedureInput,
  type ProcedureOutput,
  type ProcedureRecord,
  type TrpcTransport,
} from '@intafaced/contracts/procedure';
import {
  deviceAuthorisationSchema,
  errorEnvelopeSchema,
  p2pLimitSchema,
  resultEnvelopeSchema,
  secondStepSchema,
} from '@intafaced/contracts/wire-envelope';
import type { z, ZodType } from 'zod';
import { uiMessage, type UiMessage } from './ui-copy';

export type RefusalReason =
  'unauthorized' | 'forbidden' | 'not_mounted' | 'not_supported' | 'unreachable' | 'invalid_response' | 'aborted' | 'error' | 'uncertain';
export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: RefusalReason;
      message: string;
      messageCopy?: UiMessage;
      code?: string;
      status?: number;
      requestId?: string;
      /** Only on `auth.too_many_attempts`: whole seconds until a retry can help, as the service sent it. */
      retryAfterSeconds?: number;
      /** Only on sign-in's `auth.account_frozen`, sent after the password verified: which state the account is in. */
      accountState?: 'frozen' | 'closed';
      /** Only on a P2P take limit: when it ends, the published bounds, what is left, and the open orders on the cap. */
      p2pLimit?: P2pLimit;
      /** Only on sign-in's `auth.device_authorisation_required`: the waiting new-device sign-in this browser holds. */
      deviceAuthorisation?: DeviceAuthorisation;
      /** Only on sign-in's `auth.mfa_required`, sent after the password verified: which second steps answer it. */
      secondStep?: SecondStep;
    };

export type DeviceAuthorisation = z.infer<typeof deviceAuthorisationSchema>;
export type SecondStep = z.infer<typeof secondStepSchema>;
export type P2pLimit = z.infer<typeof p2pLimitSchema>;
export type RequestOptions = {
  signal?: AbortSignal;
  /**
   * Send this one call with this bearer token instead of the signed-in session's. The session itself is not touched:
   * a refusal of this token never ends the session, and nothing else uses it. Used only for the short confirmation
   * token that lets a refund or a payout through (`features/pay/portal/access/step-up.ts`).
   */
  bearer?: string;
  /**
   * Service codes whose 401 is this call's own answer (a wrong confirmation code), not proof that the session ended.
   * A 401 with one of these codes does not sign the person out; any other 401 follows the normal path.
   */
  keepSessionFor?: readonly string[];
  /** Let this one small write finish after the page is left (a saved draft sent as the person navigates away). */
  keepalive?: boolean;
};
export type RestOptions = RequestOptions & {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  idempotencyKey?: string;
};

/**
 * Only the gateway's "this service is not connected in this environment" answer is permanent. A 502 or 504 is a crash, a
 * restart or a timeout, so the HTTP status alone never means "not connected".
 */
export const isServiceNotConnected = (code: string | undefined): boolean => code === 'edge.upstream_unwired';

/** The verification gates' own sentence ('Verification tier "full" required for bank in XX'): a tier, a module and a region code no customer reads. */
const VERIFY_SENTENCE = /^Verification tier "[^"]*" (?:is )?required\b/;
/**
 * A refusal for want of identity verification: the jurisdiction gate's `denied.kyc_required`, the tier guard's
 * `tier.insufficient`, or either's sentence under another code. Its words are the app's own (`verifyFirst`), never the gate's.
 */
export function needsVerification(code: string | undefined, message: string | undefined): boolean {
  return code === 'denied.kyc_required' || code === 'tier.insufficient' || VERIFY_SENTENCE.test(message ?? '');
}
/** A failure already worded as a refusal for want of verification (`needsVerification`), whichever path made it. */
export function isVerifyFirst(result: { messageCopy?: UiMessage; code?: string | null }): boolean {
  return result.messageCopy?.key === 'verifyFirst' || needsVerification(result.code ?? undefined, undefined);
}

/** Keep authored copy separate from opaque service explanations. The descriptor
 * also lets a mounted refusal follow a later device-language change. */
export function authoredRefusal(reason: RefusalReason, messageCopy: UiMessage, status?: number): Extract<ApiResult<never>, { ok: false }> {
  return { ok: false, reason, message: uiMessage(messageCopy), messageCopy, ...(status === undefined ? {} : { status }) };
}

/** Picks a bearer for one call by procedure name. Set by the feature that holds such tokens; none by default. */
export type ScopedBearer = (module: string, procedure: string) => string | undefined;
let scopedBearer: ScopedBearer | null = null;
/** Registers (or, with null, removes) the one resolver that supplies a per-call bearer. The token never passes through the session. */
export function setScopedBearer(resolver: ScopedBearer | null): void {
  scopedBearer = resolver;
}

export function createApiClient(
  options: {
    token?: () => string | undefined;
    canWrite?: () => boolean;
    fetch?: typeof fetch;
    /**
     * `same-origin` unless a caller must send or receive the refresh cookie across origins (session restore), or must
     * send nothing that names the person (`omit`: the address tracker's public reads carry no cookie).
     */
    credentials?: 'same-origin' | 'include' | 'omit';
    /** Per-request timeout. Default 15 s; session refresh uses a shorter one (see session-restore.ts). */
    timeoutMs?: number;
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
    const overridden = requestOptions.bearer !== undefined;
    const token = requestOptions.bearer ?? options.token?.();
    // A refusal of an override token, or of a call that owns its 401, never counts as the session ending.
    const sessionEnds = (code?: string) => !overridden && !(code !== undefined && requestOptions.keepSessionFor?.includes(code));
    if (token) headers.authorization = `Bearer ${token}`;
    if (requestOptions.idempotencyKey) headers['Idempotency-Key'] = requestOptions.idempotencyKey;
    const controller = new AbortController();
    const cancel = () => controller.abort(requestOptions.signal?.reason);
    if (requestOptions.signal?.aborted) cancel();
    else requestOptions.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('Request timed out')), options.timeoutMs ?? 15_000);
    try {
      const response = await fetcher(url, {
        method,
        headers,
        credentials: options.credentials ?? 'same-origin',
        signal: controller.signal,
        ...(requestOptions.keepalive ? { keepalive: true } : {}),
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
          if (reason === 'unauthorized' && sessionEnds()) options.onUnauthorized?.(token);
          return authoredRefusal(
            reason,
            reason === 'unreachable'
              ? { key: 'gatewayUnreachable' }
              : reason === 'uncertain'
                ? { key: 'gatewayUncertain' }
                : { key: 'unreadableRefusal' },
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
        const parsed = errorEnvelopeSchema.safeParse(body);
        const data = parsed.success ? parsed.data : undefined;
        const error = typeof data?.error === 'object' ? data.error : undefined;
        const code =
          error?.data?.intafacedCode ??
          data?.intafacedCode ??
          error?.data?.cause?.code ??
          error?.data?.code ??
          data?.code ??
          data?.name ??
          (typeof data?.error === 'string' ? data.error : undefined);
        const message = error?.message ?? data?.message;
        // The service's own reference for this request, when it sends one (error body or `x-request-id`). Never made up.
        const requestId = error?.data?.requestId ?? response.headers.get('x-request-id') ?? undefined;
        let reason: RefusalReason = 'error';
        if (response.status === 401) {
          reason = 'unauthorized';
          if (sessionEnds(code)) options.onUnauthorized?.(token);
        } else if (response.status === 403) reason = 'forbidden';
        else if (response.status === 404) reason = 'not_mounted';
        else if (response.status === 501) reason = 'not_supported';
        else if (response.status >= 500) reason = method === 'GET' ? 'unreachable' : 'uncertain';
        return {
          ...(needsVerification(code, message)
            ? authoredRefusal(reason, { key: 'verifyFirst' }, response.status)
            : message === undefined
              ? authoredRefusal(
                  reason,
                  {
                    key: isServiceNotConnected(code)
                      ? 'serviceNotConnected'
                      : reason === 'uncertain'
                        ? 'gatewayUncertain'
                        : reason === 'unreachable'
                          ? 'serviceNoAnswer'
                          : 'serviceRefusal',
                  },
                  response.status,
                )
              : { ok: false as const, reason, message, status: response.status }),
          ...(code ? { code } : {}),
          ...(requestId ? { requestId } : {}),
          ...(error?.data?.retryAfterSeconds ? { retryAfterSeconds: error.data.retryAfterSeconds } : {}),
          ...(code === 'auth.account_frozen' && error?.data?.accountState ? { accountState: error.data.accountState } : {}),
          ...(error?.data?.p2pLimit ? { p2pLimit: error.data.p2pLimit } : {}),
          ...(code === 'auth.device_authorisation_required' && error?.data?.deviceAuthorisation
            ? { deviceAuthorisation: error.data.deviceAuthorisation }
            : {}),
          ...(code === 'auth.mfa_required' && error?.data?.secondStep ? { secondStep: error.data.secondStep } : {}),
        };
      }
      const envelope = resultEnvelopeSchema.safeParse(body);
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
    } catch {
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
    /**
     * One call by its written record (`@intafaced/contracts/procedure`): the path, the input type and the reply parser all
     * come from the record the service mounts, so this caller cannot drift from it.
     */
    call<R extends AppProcedure>(
      record: R,
      input: ProcedureInput<R>,
      opts: RequestOptions & {
        /** This caller's own check over the record's answer; an answer it refuses reads as an unverified one. */
        accept?: (data: ProcedureOutput<R>) => boolean;
      } = {},
    ): Promise<ApiResult<ProcedureOutput<R>>> {
      const { accept, ...rest } = opts;
      const output = record.output as ZodType<ProcedureOutput<R>>;
      // The record's own `accept` checks (every caller's), then this caller's: a reply either refuses reads as unverified.
      const schema = output.refine((data) => replyAccepted(record, data) && (accept === undefined || accept(data)));
      const base = `/api/${encodeURIComponent(record.module)}/trpc/${encodeURIComponent(record.path)}`;
      if (record.kind === 'query')
        return request(
          `${base}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
          'GET',
          schema,
          undefined,
          false,
          rest,
        );
      const bearer = rest.bearer ?? scopedBearer?.(record.module, record.path);
      return request(base, 'POST', schema, input ?? {}, false, bearer === undefined ? rest : { ...rest, bearer });
    },
    query<T>(module: string, procedure: string, input: unknown, schema: ZodType<T>, opts: RequestOptions = {}) {
      const url = `/api/${encodeURIComponent(module)}/trpc/${encodeURIComponent(procedure)}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;
      return request(url, 'GET', schema, undefined, false, opts);
    },
    mutate<T>(module: string, procedure: string, input: unknown, schema: ZodType<T>, opts: RequestOptions = {}) {
      // A call that names its own bearer keeps it; otherwise the registered resolver may supply one for this procedure only.
      const bearer = opts.bearer ?? scopedBearer?.(module, procedure);
      return request(
        `/api/${encodeURIComponent(module)}/trpc/${encodeURIComponent(procedure)}`,
        'POST',
        schema,
        input ?? {},
        false,
        bearer === undefined ? opts : { ...opts, bearer },
      );
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
/** A record an app can call: a tRPC procedure the edge routes under a module. */
export type AppProcedure = ProcedureRecord & TrpcTransport & { readonly module: string };
/**
 * `api.call`'s `accept` for a caller that reads the record's answer through its own, stricter schema (a field it shows
 * must read as an amount, an id it keys on must not be blank): an answer the schema refuses reads as unverified.
 */
export const parsesAs =
  (schema: ZodType) =>
  (data: unknown): boolean =>
    schema.safeParse(data).success;

/**
 * One call by its record, read through the caller's own stricter schema (a `.refine()`, or a schema built for this owner):
 * an answer that schema refuses reads as unverified, and the caller gets what the schema parses, as when it called by name.
 */
export async function callAs<R extends AppProcedure, T>(
  api: Pick<ApiClient, 'call'>,
  record: R,
  input: ProcedureInput<R>,
  schema: ZodType<T>,
  opts: RequestOptions = {},
): Promise<ApiResult<T>> {
  const result = await api.call(record, input, { ...opts, accept: parsesAs(schema) });
  if (!result.ok) return result;
  return { ok: true, data: schema.parse(result.data) };
}

export function unavailable<T = never>(message: string): ApiResult<T> {
  return { ok: false, reason: 'not_supported', message };
}
