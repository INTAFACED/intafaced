import { router, TRPCError } from '@intafaced/contracts/trpc';
import { SelfFreezeLiftError, type SelfFreezeLift } from './auth/self-freeze-lift.js';
import { toSecurityStepUpTrpc, type SecurityStepUp } from './auth/security-step-up.js';
import { userCopy } from './user-copy.js';
import { IDENTITY_SELF_FREEZE_MANAGE_LIFT } from '@intafaced/contracts/identity-self-freeze-manage-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from './record-refusal.js';

function mapError(err: unknown): never {
  if (err instanceof SelfFreezeLiftError) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: userCopy(err.code),
      // The seconds left (database clock) ride the shared retry-after field, so the customer app can say how long the wait runs.
      cause: err.availableAt
        ? {
            code: err.code,
            availableAt: err.availableAt.toISOString(),
            ...(err.secondsLeft ? { details: { retryAfterSeconds: err.secondsLeft } } : {}),
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
      lift: mountRecord(
        IDENTITY_SELF_FREEZE_MANAGE_LIFT,
        async ({ ctx, input }) => {
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
        },
        codedRefusal,
      ),
    }),
  });
}
