import type { FastifyRequest } from 'fastify';
import {
  rawBodyOf,
  verifyServiceHeaders,
  verifyServiceRequest,
  type ServiceAuthMode,
  type ServiceBodyBindMode,
  type ServiceVerifier,
} from '@intafaced/contracts';

/** Per-service keys (S2S v3) for an inbound door. Absent: the door keeps the shared secret alone. */
export interface IdentityS2s {
  readonly verifier: ServiceVerifier;
  readonly mode: ServiceAuthMode;
}

/**
 * Who is calling this internal door. With keys wired, a key-signed call is named by its own key and never falls
 * back to the shared secret if it fails; in `keypair` mode a shared-secret call is refused. Without keys this is
 * exactly the old shared-secret check.
 */
export function serviceOfRequest(
  req: FastifyRequest,
  secret: string | undefined,
  bodyBind: ServiceBodyBindMode | undefined,
  s2s?: IdentityS2s,
): { readonly service: string | null; readonly rejected: string | null } {
  if (s2s) {
    const { service, rejected } = verifyServiceRequest(req, {
      verifier: s2s.verifier,
      mode: s2s.mode,
      legacySecret: secret,
      bodyBindMode: bodyBind,
    });
    return { service, rejected };
  }
  if (!secret) return { service: null, rejected: null };
  const { service, rejected } = verifyServiceHeaders(req.headers, secret, { rawBody: rawBodyOf(req), mode: bodyBind });
  return { service, rejected };
}
