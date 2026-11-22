/**
 * Inbound HMAC mill for the job twins of POST /internal/{emissions,buyback,yield}/*: only svc-token runs them.
 * Session admin:treasury is not a service caller — refuse-closed. The tRPC twins are `serviceProcedureFor([JOB_CALLER],
 * { forbidden: JOB_FORBIDDEN })` in router.ts; the HTTP doors read the same caller here.
 */
export const JOB_CALLER = 'svc-token' as const;

/** What a signed service other than svc-token is told, on the tRPC twins and the HTTP doors alike. */
export const JOB_FORBIDDEN = 'token job is callable only as svc-token';

export type TokenJobHttpAuth =
  | { readonly ok: true; readonly service: typeof JOB_CALLER }
  | { readonly ok: false; readonly status: 401; readonly code: 'token.unauthenticated'; readonly error: string }
  | { readonly ok: false; readonly status: 403; readonly code: 'token.forbidden'; readonly error: string };

/** Unsigned → 401. Wrong HMAC caller → 403. Only svc-token runs the job twins. */
export function authorizeTokenJobHttp(service: string | null): TokenJobHttpAuth {
  if (service === null) {
    return { ok: false, status: 401, code: 'token.unauthenticated', error: 'service credentials required' };
  }
  if (service !== JOB_CALLER) {
    return { ok: false, status: 403, code: 'token.forbidden', error: JOB_FORBIDDEN };
  }
  return { ok: true, service: JOB_CALLER };
}
