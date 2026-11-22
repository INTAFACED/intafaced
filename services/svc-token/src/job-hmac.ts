/**
 * Inbound HMAC mill for tRPC job twins of POST /internal/{emissions,buyback,yield}/*.
 * Session admin:treasury is not a service caller — refuse-closed.
 */
import { TRPCError } from '@trpc/server';
import { requireServiceCaller } from '@intafaced/contracts/service-auth';

export const JOB_CALLER = 'svc-token' as const;

export type TokenJobHttpAuth =
  | { readonly ok: true; readonly service: typeof JOB_CALLER }
  | { readonly ok: false; readonly status: 401; readonly code: 'token.unauthenticated'; readonly error: string }
  | { readonly ok: false; readonly status: 403; readonly code: 'token.forbidden'; readonly error: string };

export function requireTokenJobService(service: string | null): asserts service is typeof JOB_CALLER {
  requireServiceCaller(service);
  if (service !== JOB_CALLER) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'token job is callable only as svc-token',
    });
  }
}

/** Unsigned → 401. Wrong HMAC caller → 403. Only svc-token runs the job twins. */
export function authorizeTokenJobHttp(service: string | null): TokenJobHttpAuth {
  if (service === null) {
    return { ok: false, status: 401, code: 'token.unauthenticated', error: 'service credentials required' };
  }
  if (service !== JOB_CALLER) {
    return { ok: false, status: 403, code: 'token.forbidden', error: 'token job is callable only as svc-token' };
  }
  return { ok: true, service: JOB_CALLER };
}
