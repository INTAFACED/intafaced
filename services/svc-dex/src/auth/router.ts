import { TRPCError, publicJurisdictionProcedure, router } from '@intafaced/contracts';
import {
  dexAuthChallengeInputSchema,
  dexAuthChallengeOutputSchema,
  dexAuthLogoutInputSchema,
  dexAuthLogoutOutputSchema,
  dexAuthRefreshInputSchema,
  dexAuthSessionOutputSchema,
  dexAuthVerifyInputSchema,
} from '@intafaced/contracts/protocol-dex-orders';
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
 * `auth.*`: the wallet-signed order session (D-limit-dca-01). Public on the Protocol plane, region screened. Every call
 * is a mutation so a token travels in a body, never in a URL.
 */
export function orderSessionRouter(sessions: OrderSessions) {
  const door = publicJurisdictionProcedure('dex', 'protocol');
  return router({
    challenge: door
      .input(dexAuthChallengeInputSchema)
      .output(dexAuthChallengeOutputSchema)
      .mutation(({ input }) => guarded(() => sessions.challenge(input))),
    verify: door
      .input(dexAuthVerifyInputSchema)
      .output(dexAuthSessionOutputSchema)
      .mutation(({ input }) => guarded(() => sessions.verify(input))),
    refresh: door
      .input(dexAuthRefreshInputSchema)
      .output(dexAuthSessionOutputSchema)
      .mutation(({ input }) => guarded(() => sessions.refresh(input.refreshToken))),
    logout: door
      .input(dexAuthLogoutInputSchema)
      .output(dexAuthLogoutOutputSchema)
      .mutation(({ input }) => guarded(() => sessions.logout(input.accessToken))),
    logoutAll: door
      .input(dexAuthLogoutInputSchema)
      .output(dexAuthLogoutOutputSchema)
      .mutation(({ input }) => guarded(() => sessions.logoutAll(input.accessToken))),
  });
}
