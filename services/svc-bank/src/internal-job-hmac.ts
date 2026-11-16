/**
 * HTTP JobHost mutate doors always bind retained bytes.
 * Compose INTERNAL_SERVICE_BODY_BIND does not weaken this mill.
 */
import {
  verifyServiceHeaders,
  verifyServiceRequest,
  type HttpServiceRequest,
  type ServiceAuthMode,
  type ServiceRawBody,
  type ServiceVerifier,
} from '@intafaced/contracts';

/** Per-service keys (S2S v3): the whole request, because a key signs the method, path and query too. */
export interface KeyedJobAuth {
  readonly req: HttpServiceRequest;
  readonly verifier: ServiceVerifier;
  readonly mode: ServiceAuthMode;
}

export function requireInternalJobHmac(
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  rawBody: ServiceRawBody,
  keyed?: KeyedJobAuth,
): boolean {
  if (keyed) {
    return jobCaller(
      verifyServiceRequest(keyed.req, { verifier: keyed.verifier, mode: keyed.mode, legacySecret: secret, bodyBindMode: 'require' })
        .service,
    );
  }
  return jobCaller(verifyServiceHeaders(headers, secret, { rawBody, mode: 'require' }).service);
}

/**
 * Any service may run a job, except svc-edge: the edge never calls svc-bank's `/internal` doors, and it signs every
 * request it forwards from the internet with its own key, so a call signed as svc-edge here came from outside
 * (project-state #2703).
 */
function jobCaller(service: string | null): boolean {
  return service !== null && service !== 'svc-edge';
}
