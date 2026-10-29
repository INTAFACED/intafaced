import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { SelfFreezeLiftError, type SelfFreezeLift } from './auth/self-freeze-lift.js';
import { toSecurityStepUpTrpc, type SecurityStepUp } from './auth/security-step-up.js';
import { userCopy } from './user-copy.js';

function mapError(err: unknown): never {
  if (err instanceof SelfFreezeLiftError) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: userCopy(err.code),
      // The seconds left ride the shared retry-after field, so the customer app can say how long the wait still runs.
      cause: err.availableAt
        ? {
            code: err.code,
            availableAt: err.availableAt.toISOString(),
            details: { retryAfterSeconds: Math.max(1, Math.ceil((err.availableAt.getTime() - Date.now()) / 1000)) },
          }
        : { code: err.code },
    });
  }
  return toSecurityStepUpTrpc(err);
}

/**
 * Top-level `selfFreezeManage` (W-security-accounts-03). Order: the owner wait must be published,
 * the open freeze must be due (read-only), then the step-up approval is spent, then the lift runs under the row lock. Self-freeze itself
 * stays at `auth.selfFreeze` and applies at once.
 */
export function createSelfFreezeLiftRouter(lift: SelfFreezeLift, stepUp: SecurityStepUp) {
  return router({
    selfFreezeManage: router({
      lift: scopedProcedure('identity:write')
        .input(z.object({ clientRequestId: z.string().min(1).max(128), stepUpApprovalId: z.string().min(1).max(128).nullish() }).strict())
        .output(z.object({ frozen: z.literal(false), changed: z.boolean(), liftedAt: z.string().nullable() }))
        .mutation(async ({ ctx, input }) => {
          try {
            lift.assertConfigured();
            await lift.assertDue(ctx.principal.userId);
            await stepUp.require(
              ctx.principal,
              'identity.step_up.self_freeze_lift',
              { clientRequestId: input.clientRequestId },
              input.stepUpApprovalId,
            );
            const done = await lift.lift(ctx.principal.userId);
            return { frozen: false as const, changed: done.changed, liftedAt: done.liftedAt ? done.liftedAt.toISOString() : null };
          } catch (err) {
            return mapError(err);
          }
        }),
    }),
  });
}
