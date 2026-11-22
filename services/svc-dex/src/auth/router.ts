import { TRPCError, router } from '@intafaced/contracts/trpc';
import {
  DEX_AUTH_CHALLENGE,
  DEX_AUTH_LOGOUT,
  DEX_AUTH_LOGOUT_ALL,
  DEX_AUTH_REFRESH,
  DEX_AUTH_VERIFY,
} from '@intafaced/contracts/dex-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { dexRefusal } from '../refusal.js';
import { OrderSessionRefused, authCodes, type OrderSessions } from './order-session.js';

/** The HTTP shape of an order-session refusal, its code leading the message as every svc-dex refusal does. */
export function orderSessionTrpcError(err: OrderSessionRefused): TRPCError {
  const code =
    err.code === authCodes.unauthenticated || err.code === authCodes.signatureNotOwner
      ? 'UNAUTHORIZED'
      : err.code === authCodes.forbidden
        ? 'FORBIDDEN'
        : err.code === authCodes.challengeReplayed
          ? 'CONFLICT'
          : err.code === authCodes.challengeInvalid
            ? 'BAD_REQUEST'
            : 'PRECONDITION_FAILED';
  return new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
}

async function guarded<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof OrderSessionRefused) throw orderSessionTrpcError(err);
    throw err;
  }
}

/**
 * `auth.*`: the wallet-signed order session (D-limit-dca-01), mounted from svc-dex's records
 * (`@intafaced/contracts/dex-procedures`). Public on the Protocol plane, region screened. Every call is a mutation so a
 * token travels in a body, never in a URL.
 */
export function orderSessionRouter(sessions: OrderSessions) {
  return router({
    challenge: mountRecord(DEX_AUTH_CHALLENGE, ({ input }) => guarded(() => sessions.challenge(input)), dexRefusal),
    verify: mountRecord(DEX_AUTH_VERIFY, ({ input }) => guarded(() => sessions.verify(input)), dexRefusal),
    refresh: mountRecord(DEX_AUTH_REFRESH, ({ input }) => guarded(() => sessions.refresh(input.refreshToken)), dexRefusal),
    logout: mountRecord(DEX_AUTH_LOGOUT, ({ input }) => guarded(() => sessions.logout(input.accessToken)), dexRefusal),
    logoutAll: mountRecord(DEX_AUTH_LOGOUT_ALL, ({ input }) => guarded(() => sessions.logoutAll(input.accessToken)), dexRefusal),
  });
}
