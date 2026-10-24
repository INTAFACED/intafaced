import { z } from 'zod';
import { publicProcedure, router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { AuthService } from './auth/auth-service.js';
import { MfaResetError } from './auth/mfa-reset.js';
import { SecurityStepUpError, toSecurityStepUpTrpc } from './auth/security-step-up.js';
import { toTrpcError } from './router.js';
import { userCopy } from './user-copy.js';

const told = z.object({ email: z.string(), sms: z.literal('vendor.sms').nullable() }).strict();
const viewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('code_sent'), resetId: z.string().guid(), email: z.string(), codeExpiresAt: z.string() }).strict(),
  z.object({ state: z.literal('waiting'), resetId: z.string().guid(), completesAt: z.string(), told }).strict(),
]);
const statusSchema = z
  .object({ waiting: z.object({ resetId: z.string().guid(), waitingSince: z.string(), completesAt: z.string() }).strict().nullable() })
  .strict();

/**
 * A blank setting or switched-off mail is 412, a wrong or spent code 401, a lockout 429 with its seconds; a delegated
 * caller is refused as in the security lock.
 */
function mapError(err: unknown): never {
  if (err instanceof MfaResetError) {
    const code =
      err.code === 'auth.code_invalid' || err.code === 'auth.code_expired'
        ? 'UNAUTHORIZED'
        : err.code === 'auth.too_many_attempts'
          ? 'TOO_MANY_REQUESTS'
          : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: userCopy(err.code), cause: err });
  }
  if (err instanceof SecurityStepUpError) return toSecurityStepUpTrpc(err);
  throw toTrpcError(err);
}

/** An API key or a sub-account is not the person at the keyboard: it may not stop a reset of the account's second step. */
function refuseDelegated(principal: { kid?: string | null | undefined; sub_account?: string | null | undefined }): void {
  if (principal.kid || principal.sub_account) throw new SecurityStepUpError('identity.delegated_refused');
}

/**
 * Top-level `mfaReset` (I-signin-sessions-12, J-identity-05 #2/#3): the locked-out second-factor reset. `start` and
 * `confirm` are signed out: the password again, then the mailed code, which starts the owner's wait and tells every
 * contact. `status` and `cancel` are for the account's own signed-in sessions, which can stop it. Once the wait has
 * passed, the next password sign-in completes it.
 */
export function createMfaResetRouter(auth: AuthService) {
  return router({
    mfaReset: router({
      start: publicProcedure
        .input(z.object({ identifier: z.string().min(1).max(320), password: z.string().min(1).max(200) }).strict())
        .output(viewSchema)
        .mutation(async ({ input }) => {
          try {
            return await auth.mfaResetStart(input);
          } catch (err) {
            return mapError(err);
          }
        }),
      confirm: publicProcedure
        .input(z.object({ resetId: z.string().guid(), code: z.string().min(1).max(16) }).strict())
        .output(viewSchema)
        .mutation(async ({ input }) => {
          try {
            return await auth.mfaResetConfirm(input);
          } catch (err) {
            return mapError(err);
          }
        }),
      status: scopedProcedure('identity:read')
        .output(statusSchema)
        .query(async ({ ctx }) => {
          try {
            return { waiting: await auth.mfaResetStatus(ctx.principal.userId) };
          } catch (err) {
            return mapError(err);
          }
        }),
      cancel: scopedProcedure('identity:write')
        .input(z.object({}).strict().optional())
        .output(z.object({ cancelled: z.boolean() }).strict())
        .mutation(async ({ ctx }) => {
          try {
            refuseDelegated(ctx.principal);
            return await auth.mfaResetCancel({ userId: ctx.principal.userId, sessionId: ctx.principal.sid });
          } catch (err) {
            return mapError(err);
          }
        }),
    }),
  });
}
