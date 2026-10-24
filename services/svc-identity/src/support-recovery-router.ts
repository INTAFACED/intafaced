import { z } from 'zod';
import { protectedProcedure, publicProcedure, router, TRPCError } from '@intafaced/contracts';
import { supportRecoveryCaseSchema, supportRecoveryRedeemSchema } from '@intafaced/contracts/identity';
import {
  SupportRecoveryError,
  cancelSupportRecoveryCase,
  openSupportRecoveryCase,
  readSupportRecoveryCase,
  redeemSupportRecoveryLink,
  sendSupportRecoveryLink,
  type SupportRecoveryDeps,
} from './auth/support-recovery.js';
import { toTrpcError } from './router.js';
import { userCopy } from './user-copy.js';

/** Who is not an operator is 403, a missing second factor 401, an unknown case 404, a dead link 401, the rest 412. */
function mapError(err: unknown): never {
  if (err instanceof SupportRecoveryError) {
    const code =
      err.code === 'operator.denied' || err.code === 'identity.support_recovery_self'
        ? 'FORBIDDEN'
        : err.code === 'mfa.required' || err.code === 'identity.support_recovery_link_invalid'
          ? 'UNAUTHORIZED'
          : err.code === 'identity.support_recovery_not_found'
            ? 'NOT_FOUND'
            : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  throw toTrpcError(err);
}

/**
 * Top-level `supportRecovery` (I-signin-sessions-24; J-identity-05 #5, J-identity-19 #1-#3). `open`, `case`, `sendLink`
 * and `cancel` are operator doors (the scope and the second factor are checked in support-recovery.ts, on a live session).
 * `redeem` is the signed-out page the mailed link opens.
 */
export function createSupportRecoveryRouter(deps: () => SupportRecoveryDeps) {
  const caseId = z.object({ caseId: z.string().guid() }).strict();
  return router({
    supportRecovery: router({
      open: protectedProcedure
        .input(
          z
            .object({
              userId: z.string().guid(),
              reason: z.string().trim().min(1).max(500),
              requestId: z.string().trim().min(1).max(128),
            })
            .strict(),
        )
        .output(supportRecoveryCaseSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await openSupportRecoveryCase(deps(), ctx, input);
          } catch (err) {
            return mapError(err);
          }
        }),
      case: protectedProcedure
        .input(caseId)
        .output(supportRecoveryCaseSchema)
        .query(async ({ ctx, input }) => {
          try {
            return await readSupportRecoveryCase(deps(), ctx, input.caseId);
          } catch (err) {
            return mapError(err);
          }
        }),
      sendLink: protectedProcedure
        .input(z.object({ caseId: z.string().guid(), approvalId: z.string().trim().min(1).max(128) }).strict())
        .output(supportRecoveryCaseSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await sendSupportRecoveryLink(deps(), ctx, input);
          } catch (err) {
            return mapError(err);
          }
        }),
      cancel: protectedProcedure
        .input(caseId)
        .output(supportRecoveryCaseSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await cancelSupportRecoveryCase(deps(), ctx, input.caseId);
          } catch (err) {
            return mapError(err);
          }
        }),
      redeem: publicProcedure
        .input(z.object({ token: z.string().min(1).max(128) }).strict())
        .output(supportRecoveryRedeemSchema)
        .mutation(async ({ input }) => {
          try {
            return await redeemSupportRecoveryLink(deps(), input);
          } catch (err) {
            return mapError(err);
          }
        }),
    }),
  });
}
