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
    return (
      verifyServiceRequest(keyed.req, { verifier: keyed.verifier, mode: keyed.mode, legacySecret: secret, bodyBindMode: 'require' })
        .service !== null
    );
  }
  return verifyServiceHeaders(headers, secret, { rawBody, mode: 'require' }).service !== null;
}
