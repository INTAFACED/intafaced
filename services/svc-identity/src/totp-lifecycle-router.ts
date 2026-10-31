import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { AuthError } from './auth/auth-service.js';
import { toSecurityStepUpTrpc, type SecurityStepUp } from './auth/security-step-up.js';
import { TotpLifecycleError, type TotpLifecycle } from './auth/totp-lifecycle.js';
import { userCopy } from './user-copy.js';

const status = z.object({
  enabled: z.boolean(),
  label: z.string().nullable(),
  enrolledAt: z.string().nullable(),
  recoveryCodesLeft: z.number().int(),
});
const code = z.string().trim().min(6).max(64);
const requestId = z.string().min(1).max(128);
const approvalId = z.string().min(1).max(128).nullish();

function mapError(err: unknown): never {
  if (err instanceof TotpLifecycleError) {
    const trpc = err.code === 'auth.not_found' ? 'NOT_FOUND' : err.code === 'identity.totp_label_invalid' ? 'BAD_REQUEST' : 'FORBIDDEN';
    throw new TRPCError({ code: trpc, message: userCopy(err.code), cause: err });
  }
  if (err instanceof AuthError) {
    const trpc =
      err.code === 'auth.mfa_invalid' ? 'UNAUTHORIZED' : err.code === 'auth.too_many_attempts' ? 'TOO_MANY_REQUESTS' : 'FORBIDDEN';
    throw new TRPCError({ code: trpc, message: userCopy(err.code), cause: err });
  }
  return toSecurityStepUpTrpc(err);
}

/**
 * Top-level `totpManage` (not nested under `totp`, so mergeRouters cannot replace the older enrol door).
 * Disable and replace validate input, then spend the step-up approval, then prove the current authenticator
 * with a code or a recovery code (counted on the MFA lockout), then write.
 */
export function createTotpLifecycleRouter(lifecycle: TotpLifecycle, stepUp: SecurityStepUp) {
  return router({
    totpManage: router({
      status: scopedProcedure('identity:read')
        .output(status)
        .query(async ({ ctx }) => {
          try {
            return await lifecycle.status(ctx.principal.userId);
          } catch (err) {
            return mapError(err);
          }
        }),
      rename: scopedProcedure('identity:write')
        .input(z.object({ label: z.string().max(256) }).strict())
        .output(status)
        .mutation(async ({ ctx, input }) => {
          try {
            return await lifecycle.rename(ctx.principal.userId, input.label);
          } catch (err) {
            return mapError(err);
          }
        }),
      disable: scopedProcedure('identity:write')
        .input(z.object({ code, clientRequestId: requestId, stepUpApprovalId: approvalId }).strict())
        .output(z.object({ disabled: z.literal(true), recoveryCodeSpent: z.boolean() }))
        .mutation(async ({ ctx, input }) => {
          try {
            // Already off answers ok before the guard: the guard needs a second factor, and there is none left.
            if (!(await lifecycle.isEnabled(ctx.principal.userId))) return { disabled: true as const, recoveryCodeSpent: false };
            await stepUp.require(
              ctx.principal,
              'identity.step_up.totp_disable',
              { clientRequestId: input.clientRequestId },
              input.stepUpApprovalId,
            );
            return await lifecycle.disable(ctx.principal.userId, input.code);
          } catch (err) {
            return mapError(err);
          }
        }),
      replaceStart: scopedProcedure('identity:write')
        // A session that signed in without its second factor (for example one that turned the authenticator on just
        // now) starts with the confirmation it just gave: the same approval replaceConfirm then spends.
        .input(z.object({ clientRequestId: requestId, stepUpApprovalId: approvalId }).strict().optional())
        .output(z.object({ secret: z.string(), uri: z.string() }))
        .mutation(async ({ ctx, input }) => {
          try {
            if (!ctx.principal.mfa) {
              if (!input?.clientRequestId || !input.stepUpApprovalId) {
                throw new TRPCError({ code: 'FORBIDDEN', message: userCopy('auth.step_up_required') });
              }
              await stepUp.assertHeld(
                ctx.principal,
                'identity.step_up.totp_replace',
                { clientRequestId: input.clientRequestId },
                input.stepUpApprovalId,
              );
            }
            return await lifecycle.replaceStart(ctx.principal.userId);
          } catch (err) {
            if (err instanceof TRPCError) throw err;
            return mapError(err);
          }
        }),
      replaceConfirm: scopedProcedure('identity:write')
        .input(
          z
            .object({
              secret: z.string().min(16).max(128),
              newCode: z.string().regex(/^\d{6}$/),
              currentCode: code,
              clientRequestId: requestId,
              stepUpApprovalId: approvalId,
            })
            .strict(),
        )
        .output(
          z.object({
            replaced: z.literal(true),
            recoveryCodeSpent: z.boolean(),
            recoveryCodes: z.array(z.string()),
            sessionsEnded: z.number().int().min(0),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            await stepUp.require(
              ctx.principal,
              'identity.step_up.totp_replace',
              { clientRequestId: input.clientRequestId },
              input.stepUpApprovalId,
            );
            return await lifecycle.replaceConfirm(ctx.principal.userId, input, ctx.principal.sid);
          } catch (err) {
            return mapError(err);
          }
        }),
    }),
  });
}
