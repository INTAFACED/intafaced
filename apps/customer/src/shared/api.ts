import { P2P_DELIST_REASONS } from '@intafaced/contracts/p2p-delist';
import { P2P_FIELD_KEY, P2P_RULE_CLASS } from '@intafaced/contracts/p2p-rule-class';
import { z, type ZodType } from 'zod';
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

/** A new-device sign-in waiting for approval (svc-identity I-signin-sessions-07, contracts `deviceAuthorisationOf`). */
export const deviceAuthorisationSchema = z.object({
  flowId: z.string().guid(),
  secret: z.string().min(16).max(128),
  expiresAt: z.string().datetime({ offset: true }),
  mailed: z.boolean(),
  /** Only when this sign-in's second step spent a recovery code: how many are left (I-signin-sessions-12). */
  recoveryCodesLeft: z.number().int().min(0).optional(),
});
export type DeviceAuthorisation = z.infer<typeof deviceAuthorisationSchema>;

/** The second steps a sign-in may answer with, and the passkey challenge when one does (contracts `secondStepOf`). */
export const secondStepSchema = z.object({
  totp: z.boolean(),
  passkey: z
    .object({
      challenge: z.string().min(1),
      timeout: z.number().optional(),
      rpId: z.string().optional(),
      allowCredentials: z
        .array(z.object({ id: z.string().min(1), type: z.literal('public-key'), transports: z.array(z.string()).optional() }))
        .min(1),
      userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(),
    })
    .nullable(),
});
export type SecondStep = z.infer<typeof secondStepSchema>;

const limitDecimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
/** The figures behind a P2P take limit, as svc-p2p sends them (contracts `p2pLimitOf`). Anything malformed is dropped. */
export const p2pLimitSchema = z.object({
  until: z.string().datetime().nullable(),
  cap: limitDecimal.optional(),
  min: limitDecimal.optional(),
  max: limitDecimal.optional(),
  remaining: limitDecimal.optional(),
  windowHours: limitDecimal.optional(),
  available: limitDecimal.optional(),
  shortBy: limitDecimal.optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  openTradeIds: z.array(z.string().guid()).max(50).optional(),
  /** On `p2p.offer_has_open_trades`: how many orders on the ad are open. */
  openTrades: limitDecimal.optional(),
  reason: z.enum(P2P_DELIST_REASONS).optional(),
  ruleClass: z.string().regex(P2P_RULE_CLASS).optional(),
  /** The field a refused payment-method detail is about (`p2p.account_format_invalid`, field missing or invalid). */
  field: z.string().regex(P2P_FIELD_KEY).optional(),
});
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
                requestId: z.string().optional(),
                retryAfterSeconds: z.number().int().positive().optional(),
                accountState: z.enum(['frozen', 'closed']).optional().catch(undefined),
                p2pLimit: p2pLimitSchema.optional().catch(undefined),
                deviceAuthorisation: deviceAuthorisationSchema.optional().catch(undefined),
                secondStep: secondStepSchema.optional().catch(undefined),
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
    // The public market routes answer in the exchange error shape: `code` is a broad class such as "ExchangeError" and the
    // specific reason, such as `trade.no_book`, sits beside it.
    intafacedCode: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

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
    /** `same-origin` unless a caller must send or receive the refresh cookie across origins (session restore). */
    credentials?: 'same-origin' | 'include';
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
        const parsed = errorEnvelope.safeParse(body);
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
          ...(message === undefined
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
export function unavailable<T = never>(message: string): ApiResult<T> {
  return { ok: false, reason: 'not_supported', message };
}
