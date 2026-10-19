/**
 * Inbound HMAC mill for OMS writes (HTTP POSTs + tRPC mutations).
 * Matching already requires HMAC as svc-execution on child POST/DELETE.
 * Session admin:write is not a service caller — refuse-closed.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { TRPCError } from '@trpc/server';
import {
  ServiceAuthError,
  rawBodyOf,
  requireServiceCaller,
  retainRawBody,
  verifyServiceHeaders,
  verifyServiceRequest,
  type ServiceAuthMode,
  type ServiceRawBody,
  type ServiceVerifier,
} from '@intafaced/contracts';

/** Per-service keys (S2S v3): set only when S2S_AUTH_MODE is on; unset keeps the shared secret alone. */
export type OmsWriteS2s = { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };

export const OMS_WRITE_CALLER = 'svc-execution' as const;
export const OMS_WRITE_SECRET_ENV = 'INTERNAL_SERVICE_SECRET';
const MIN_SECRET_LENGTH = 32;

export type OmsWriteHmacOk = { readonly ok: true; readonly service: typeof OMS_WRITE_CALLER };
export type OmsWriteHmacRefuse = {
  readonly ok: false;
  readonly status: 401 | 403;
  readonly body: { readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' };
};

export function installOmsWriteRawBody(app: FastifyInstance): void {
  retainRawBody(app);
}

export function readOmsWriteSecret(explicit?: string | null): string | undefined {
  const fromDep = explicit?.trim() ?? '';
  if (fromDep.length >= MIN_SECRET_LENGTH) return fromDep;
  const fromEnv = process.env[OMS_WRITE_SECRET_ENV]?.trim() ?? '';
  return fromEnv.length >= MIN_SECRET_LENGTH ? fromEnv : undefined;
}

/** Unsigned → 401. Wrong HMAC caller (svc-trade) → 403. Only svc-execution writes. */
export function authorizeOmsWriteHmac(
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined,
  rawBody: ServiceRawBody = { retained: false },
): OmsWriteHmacOk | OmsWriteHmacRefuse {
  const trimmed = secret?.trim() ?? '';
  if (trimmed.length < MIN_SECRET_LENGTH) {
    return { ok: false, status: 401, body: { code: 'UNAUTHORIZED' } };
  }
  try {
    // OMS writes always bind retained bytes. Compose INTERNAL_SERVICE_BODY_BIND does not weaken this mill.
    const verification = verifyServiceHeaders(headers, trimmed, { rawBody, mode: 'require' });
    if (!verification.service) {
      return { ok: false, status: 401, body: { code: 'UNAUTHORIZED' } };
    }
    if (verification.service !== OMS_WRITE_CALLER) {
      return { ok: false, status: 403, body: { code: 'FORBIDDEN' } };
    }
    return { ok: true, service: OMS_WRITE_CALLER };
  } catch (err) {
    if (err instanceof ServiceAuthError) {
      return { ok: false, status: 401, body: { code: 'UNAUTHORIZED' } };
    }
    throw err;
  }
}

/** Production HTTP doors: digest the bytes Fastify actually received. */
export function authorizeOmsWriteRequest(
  req: FastifyRequest,
  secret: string | undefined | null,
  s2s?: OmsWriteS2s,
): OmsWriteHmacOk | OmsWriteHmacRefuse {
  if (!s2s) return authorizeOmsWriteHmac(req.headers, readOmsWriteSecret(secret), rawBodyOf(req));
  // A failed key-signed call is refused and never retried on the shared secret.
  const verification = verifyServiceRequest(req, {
    verifier: s2s.verifier,
    mode: s2s.mode,
    legacySecret: readOmsWriteSecret(secret),
    bodyBindMode: 'require',
  });
  if (!verification.service) return { ok: false, status: 401, body: { code: 'UNAUTHORIZED' } };
  if (verification.service !== OMS_WRITE_CALLER) return { ok: false, status: 403, body: { code: 'FORBIDDEN' } };
  return { ok: true, service: OMS_WRITE_CALLER };
}

export function requireOmsWriteService(service: string | null): asserts service is typeof OMS_WRITE_CALLER {
  requireServiceCaller(service);
  if (service !== OMS_WRITE_CALLER) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'OMS writes are callable only as svc-execution',
    });
  }
}
