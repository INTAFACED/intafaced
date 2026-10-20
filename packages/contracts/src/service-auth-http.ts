import { SERVICE_SIGNATURE_HEADER, serviceAuthHeadersForBody, verifyServiceHeaders, type ServiceBodyBindMode } from './service-auth.js';
import { inboundRawBodyOf } from './raw-body.js';
import {
  S2S_AUDIENCE_HEADER,
  S2S_BODY_HEADER,
  S2S_KID_HEADER,
  S2S_NONCE_HEADER,
  S2S_SIGNATURE_HEADER,
  S2S_TIMESTAMP_HEADER,
  type ServiceName,
  type ServiceSignedContext,
  type ServiceSigner,
  type ServiceVerifier,
} from './service-keys.js';

/**
 * Glue between the key-pair scheme and the existing shared-secret scheme, so a
 * service can accept both while the fleet moves over. Nothing here is used by a
 * service until it passes a `ServiceVerifier`; without one, behaviour is exactly
 * what it was.
 */

/** `dual` accepts key-signed and shared-secret calls; `keypair` refuses the shared secret. */
export type ServiceAuthMode = 'dual' | 'keypair';

export interface HttpServiceRequest {
  method?: string;
  /** The raw request target as received: path and query. */
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ServiceRequestAuth {
  /** The verified caller; null when there is none or the credentials failed. */
  service: string | null;
  /** `keypair`: named by the key that verified. `shared`: a name claimed under the shared secret. */
  scheme: 'keypair' | 'shared' | null;
  /** Why credentials were refused. Null both for success and for a request with no service credentials. */
  rejected: string | null;
}

export interface ServiceRequestAuthOptions {
  verifier?: ServiceVerifier | undefined;
  legacySecret?: string | undefined;
  mode?: ServiceAuthMode | undefined;
  /** Body binding for the shared-secret form. Defaults to `require`. */
  bodyBindMode?: ServiceBodyBindMode | undefined;
}

const NONE: ServiceRequestAuth = { service: null, scheme: null, rejected: null };
const MEMO = new WeakMap<object, ServiceRequestAuth>();
const V3_HEADERS = [
  S2S_KID_HEADER,
  S2S_AUDIENCE_HEADER,
  S2S_TIMESTAMP_HEADER,
  S2S_NONCE_HEADER,
  S2S_BODY_HEADER,
  S2S_SIGNATURE_HEADER,
] as const;

/**
 * Who is calling, judged once per request. A key-signed call is verified by the
 * key and never falls back to the shared secret if it fails. A request with no
 * service credentials reports no caller, not a refusal (it is a user or anonymous
 * request). The result is remembered per request object so a second read cannot
 * trip the replay cache.
 */
export function verifyServiceRequest(req: HttpServiceRequest, options: ServiceRequestAuthOptions): ServiceRequestAuth {
  const memo = MEMO.get(req);
  if (memo) return memo;
  const result = judge(req, options);
  MEMO.set(req, result);
  return result;
}

function judge(req: HttpServiceRequest, options: ServiceRequestAuthOptions): ServiceRequestAuth {
  const rawBody = inboundRawBodyOf(req);
  if (options.verifier && V3_HEADERS.some((h) => req.headers[h] !== undefined)) {
    if (typeof req.method !== 'string' || typeof req.url !== 'string') return { service: null, scheme: null, rejected: 'malformed' };
    const outcome = options.verifier.verify({ method: req.method, url: req.url, headers: req.headers, rawBody });
    if (outcome.status === 'accepted') return { service: outcome.service, scheme: 'keypair', rejected: null };
    if (outcome.status === 'rejected') return { service: null, scheme: null, rejected: outcome.reason };
  }
  if (req.headers[SERVICE_SIGNATURE_HEADER] === undefined) return NONE;
  if ((options.mode ?? 'dual') === 'keypair') return { service: null, scheme: null, rejected: 'legacy-refused' };
  if (!options.legacySecret) return NONE;
  const legacy = verifyServiceHeaders(req.headers, options.legacySecret, { rawBody, mode: options.bodyBindMode ?? 'require' });
  return legacy.service === null
    ? { service: null, scheme: null, rejected: legacy.rejected }
    : { service: legacy.service, scheme: 'shared', rejected: null };
}

export interface S2sRequestInput {
  audience: ServiceName;
  method: string;
  url: URL;
  body?: string | undefined;
  context?: ServiceSignedContext | undefined;
}

/** Headers for one service call: key-signed, plus the shared-secret form while `legacySecret` is passed. */
export function s2sRequestHeaders(
  signer: ServiceSigner,
  input: S2sRequestInput,
  options: { legacySecret?: string | undefined } = {},
): Record<string, string> {
  const headers = signer.headers({
    audience: input.audience,
    method: input.method,
    url: input.url,
    body: input.body,
    context: input.context,
  });
  return options.legacySecret
    ? { ...headers, ...serviceAuthHeadersForBody(signer.service, options.legacySecret, input.body ?? '') }
    : headers;
}

/**
 * fetch with a signed service call. It fixes `content-type` before signing, so
 * the signed context equals what goes on the wire (a body sent with no
 * content-type would otherwise get one added after signing), and signs each call.
 */
export async function s2sFetch(
  signer: ServiceSigner,
  audience: ServiceName,
  url: URL,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
  options: { legacySecret?: string | undefined; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(init.headers ?? {})) headers[name.toLowerCase()] = value;
  if (init.body !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  const signed = s2sRequestHeaders(
    signer,
    {
      audience,
      method,
      url,
      body: init.body,
      context: {
        principal: headers['x-intafaced-principal'],
        principalSignature: headers['x-intafaced-principal-sig'],
        region: headers['x-intafaced-region'],
        contentType: headers['content-type'],
      },
    },
    { legacySecret: options.legacySecret },
  );
  return (options.fetchImpl ?? fetch)(url, { method, headers: { ...headers, ...signed }, body: init.body, signal: init.signal });
}

export interface ServiceCallSignerOptions {
  /** The service making the calls. */
  service: ServiceName;
  /** The service receiving them. */
  audience: ServiceName;
  /** The shared secret. Sent only while the service is not in `keypair` mode. */
  legacySecret: string;
  /** Present once the service has a signing key and S2S is on; absent leaves the call on the shared secret alone. */
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode } | undefined;
}

/**
 * What a signed call is about. `forwarded` is the edge-signed principal a service passes on while acting for a user
 * (`ctx.forwardedPrincipal`): the key signature then covers it, and the caller sends the same bytes with
 * `forwardedPrincipalHeaders`. Without it the call runs as the service itself.
 */
export interface ServiceCallRequest {
  method: string;
  url: URL;
  contentType: string;
  forwarded?: { raw: string; signature: string; region: string } | undefined;
}

/**
 * The `sign` callback for an HTTP client that posts JSON to one service. It reads what is being sent (the
 * ledger client passes method, URL and content type) and returns the headers for that exact call. Without a
 * signing key the call is signed as it always was; with one, `dual` sends both forms and `keypair` sends the key
 * signature only.
 */
export function serviceCallSigner(
  options: ServiceCallSignerOptions,
): (payload: string, request: ServiceCallRequest) => Record<string, string> {
  return (payload, request) => {
    if (!options.s2s) return serviceAuthHeadersForBody(options.service, options.legacySecret, payload);
    return s2sRequestHeaders(
      options.s2s.signer,
      {
        audience: options.audience,
        method: request.method,
        url: request.url,
        body: payload,
        context: {
          contentType: request.contentType,
          ...(request.forwarded
            ? { principal: request.forwarded.raw, principalSignature: request.forwarded.signature, region: request.forwarded.region }
            : {}),
        },
      },
      { legacySecret: options.s2s.mode === 'keypair' ? undefined : options.legacySecret },
    );
  };
}
