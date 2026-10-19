/**
 * Inbound S2S HMAC for p2p internal GETs.
 *
 * Bytes must be retained (`retainRawBody`) or a v2 digest cannot be checked
 * against the wire. GETs bind the empty body.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  DEFAULT_SERVICE_BODY_BIND_MODE,
  retainRawBody,
  verifyServiceRequest,
  type ServiceAuthMode,
  type ServiceBodyBindMode,
  type ServiceVerifier,
} from '@intafaced/contracts';

export function installP2pS2sRawBody(app: FastifyInstance): void {
  retainRawBody(app);
}

/** Per-service keys (S2S v3): set only when S2S_AUTH_MODE is on; unset keeps the shared secret alone. */
export type P2pS2s = { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };

/** A failed key-signed call is refused and never retried on the shared secret. */
export function p2pInternalServiceOf(
  req: FastifyRequest,
  secret: string,
  mode: ServiceBodyBindMode = DEFAULT_SERVICE_BODY_BIND_MODE,
  s2s?: P2pS2s,
): string | null {
  return verifyServiceRequest(req, { verifier: s2s?.verifier, mode: s2s?.mode, legacySecret: secret, bodyBindMode: mode }).service;
}
