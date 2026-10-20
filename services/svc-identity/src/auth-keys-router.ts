import { z } from 'zod';
import { protectedProcedure, router, TRPCError } from '@intafaced/contracts';
import { isInteractiveFounderPrincipal } from './auth/action-approval-audience.js';
import { AuthKeyError, type AuthKeyRing } from './auth/auth-key-ring.js';

const stateOut = z.object({
  activeKeyId: z.string(),
  previousKeyIds: z.array(z.string()),
  activatedAt: z.string().nullable(),
  nextRemoval: z.array(z.string()).nullable(),
  availableKeyIds: z.array(z.string()),
});

const approval = {
  approvalId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
};

/**
 * Founder-ops signing-key rotation (/identity-ops/keys). Only a live founder on an interactive
 * second-factor session may read or change it; rotate and remove-old also consume a four-eyes approval.
 * Key material is never returned or logged: only ids.
 */
export function createAuthKeysRouter(ring: AuthKeyRing, founders: { isFounder(userId: string): Promise<boolean> }) {
  const founder = protectedProcedure.use(async ({ ctx, next }) => {
    const p = ctx.principal;
    if (!isInteractiveFounderPrincipal(p) || !(await founders.isFounder(p.userId)))
      throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
    return next();
  });
  const map = (err: unknown): never => {
    if (err instanceof AuthKeyError)
      throw new TRPCError({
        code: err.code === 'auth_key.approval_required' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST',
        message: err.code,
        cause: err,
      });
    throw err;
  };

  return router({
    authKeys: router({
      state: founder.output(stateOut).query(() => ring.state()),
      rotate: founder
        .input(z.object({ keyId: z.string().min(1).max(32), ...approval }).strict())
        .output(stateOut)
        .mutation(({ ctx, input }) => ring.rotate({ ...input, actorId: ctx.principal.userId }).catch(map)),
      removeOld: founder
        .input(z.object(approval).strict())
        .output(stateOut)
        .mutation(({ ctx, input }) => ring.removeOld({ ...input, actorId: ctx.principal.userId }).catch(map)),
    }),
  });
}
