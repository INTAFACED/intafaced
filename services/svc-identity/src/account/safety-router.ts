/**
 * `account.safety.*` (BK-safe-01, J-bank-18 #4): the person's own step-up extras and location signal. Shapes and
 * refusals: `@intafaced/contracts/identity-safety`. Customer sessions only; an API key or sub-account is refused.
 */
import { protectedProcedure, router, TRPCError } from '@intafaced/contracts';
import {
  clearExtraControlsInputSchema,
  safetyChangeOutputSchema,
  safetyReadOutputSchema,
  setExtraControlsInputSchema,
  setLocationConsentInputSchema,
} from '@intafaced/contracts/identity-safety';
import { AuthError, type AuthService } from '../auth/auth-service.js';
import { factorActor } from '../auth/factor-gate.js';
import { toTrpcError } from '../router.js';
import { userCopy } from '../user-copy.js';
import { clearExtraControls, readSafety, SafetyError, setExtraControls, setLocationConsent } from './safety.js';

function toTrpc(err: unknown): never {
  if (err instanceof SafetyError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: userCopy(err.code), cause: err });
  }
  if (err instanceof AuthError && err.code === 'auth.invalid_credentials') {
    throw new TRPCError({ code: 'FORBIDDEN', message: userCopy(err.code), cause: err });
  }
  throw toTrpcError(err);
}

export function createSafetyRouter(auth: AuthService, privilegedUserIds: readonly string[], extraControlsMin: () => number | null) {
  const own = (principal: Parameters<typeof factorActor>[0]) => {
    const actor = factorActor(principal, privilegedUserIds);
    if (actor.delegated) throw new AuthError('Sign in yourself; an API key or sub-account cannot', 'auth.mfa_required');
    return actor;
  };
  return router({
    read: protectedProcedure.output(safetyReadOutputSchema).query(async ({ ctx }) => {
      try {
        own(ctx.principal);
        return await readSafety(auth.safetySql, ctx.principal.userId, extraControlsMin());
      } catch (err) {
        toTrpc(err);
      }
    }),

    setExtraControls: protectedProcedure
      .input(setExtraControlsInputSchema)
      .output(safetyChangeOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          const actor = own(ctx.principal);
          const minimum = extraControlsMin();
          // The owner's number is checked before the password, so a blank one never spends a password attempt.
          if (minimum === null) throw new SafetyError('identity.extra_controls_unset');
          await auth.confirmOwnPassword({ userId: ctx.principal.userId, actor, password: input.password });
          const { changed } = await setExtraControls(auth.safetySql, {
            userId: ctx.principal.userId,
            minimum,
            controls: input.controls,
            allowance: input.allowance,
          });
          return { ...(await readSafety(auth.safetySql, ctx.principal.userId, minimum)), changed };
        } catch (err) {
          toTrpc(err);
        }
      }),

    clearExtraControls: protectedProcedure
      .input(clearExtraControlsInputSchema)
      .output(safetyChangeOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          const actor = own(ctx.principal);
          await auth.confirmOwnPassword({ userId: ctx.principal.userId, actor, password: input.password });
          const { changed } = await clearExtraControls(auth.safetySql, ctx.principal.userId);
          return { ...(await readSafety(auth.safetySql, ctx.principal.userId, extraControlsMin())), changed };
        } catch (err) {
          toTrpc(err);
        }
      }),

    setLocationConsent: protectedProcedure
      .input(setLocationConsentInputSchema)
      .output(safetyChangeOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          own(ctx.principal);
          const { changed } = await setLocationConsent(auth.safetySql, ctx.principal.userId, input.consent);
          return { ...(await readSafety(auth.safetySql, ctx.principal.userId, extraControlsMin())), changed };
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
