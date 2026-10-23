import { z } from 'zod';
import { router, scopedProcedure, securityLockSchema, TRPCError } from '@intafaced/contracts';
import { SecurityLockError, type SecurityLock } from './auth/security-lock.js';
import { SecurityStepUpError, toSecurityStepUpTrpc, type SecurityStepUp } from './auth/security-step-up.js';
import { userCopy } from './user-copy.js';

const changeSchema = securityLockSchema.extend({ changed: z.boolean() }).strict();

function mapError(err: unknown): never {
  if (err instanceof SecurityLockError) {
    throw new TRPCError({
      code: err.code === 'identity.security_lock_not_found' ? 'NOT_FOUND' : 'PRECONDITION_FAILED',
      message: userCopy(err.code),
      cause: err.unlocksAt ? { code: err.code, unlocksAt: err.unlocksAt.toISOString() } : { code: err.code },
    });
  }
  return toSecurityStepUpTrpc(err);
}

/** An API key or a sub-account is not the person at the keyboard: it may neither lock nor ask to unlock. */
function refuseDelegated(principal: { kid?: string | null | undefined; sub_account?: string | null | undefined }): void {
  if (principal.kid || principal.sub_account) throw new SecurityStepUpError('identity.delegated_refused');
}

/**
 * Top-level `securityLock` (W-withdraw-09). `read` answers the caller's own lock. `set` locks at once with no step-up.
 * `requestUnlock` order: the owner wait must be published, then a lock that does not hold or already has an unlock
 * waiting answers as it stands (no approval is spent on a request that changes nothing), then the step-up approval is
 * spent, then the request is fixed under the row lock. Nothing here lifts a lock early; support has no unlock door.
 *
 * The state check before the spend is a read, not the authority. Two requests racing with two approvals, or a lock change
 * in between, can spend an approval on a request that answers `changed: false`; an approval spent and then a database
 * error also needs a new one. Both only cost the owner a fresh confirmation, never a shorter lock.
 */
export function createSecurityLockRouter(lock: SecurityLock, stepUp: SecurityStepUp) {
  return router({
    securityLock: router({
      read: scopedProcedure('identity:read')
        .output(securityLockSchema)
        .query(async ({ ctx }) => {
          try {
            const view = await lock.read(ctx.principal.userId);
            if (!view) throw new SecurityLockError('identity.security_lock_not_found');
            return view;
          } catch (err) {
            return mapError(err);
          }
        }),
      set: scopedProcedure('identity:write')
        .input(z.object({}).strict().optional())
        .output(changeSchema)
        .mutation(async ({ ctx }) => {
          try {
            refuseDelegated(ctx.principal);
            return await lock.lock(ctx.principal.userId, { kind: 'self', userId: ctx.principal.userId });
          } catch (err) {
            return mapError(err);
          }
        }),
      requestUnlock: scopedProcedure('identity:write')
        .input(z.object({ clientRequestId: z.string().min(1).max(128), stepUpApprovalId: z.string().min(1).max(128).nullish() }).strict())
        .output(changeSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            refuseDelegated(ctx.principal);
            lock.assertUnlockConfigured();
            const now = await lock.read(ctx.principal.userId);
            if (!now) throw new SecurityLockError('identity.security_lock_not_found');
            if (!now.locked || now.unlocksAt) return { ...now, changed: false };
            await stepUp.require(
              ctx.principal,
              'identity.step_up.security_lock_unlock',
              { clientRequestId: input.clientRequestId },
              input.stepUpApprovalId,
            );
            return await lock.requestUnlock(ctx.principal.userId);
          } catch (err) {
            return mapError(err);
          }
        }),
    }),
  });
}
