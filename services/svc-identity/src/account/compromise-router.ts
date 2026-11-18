/**
 * `account.compromised.*` (I-signin-sessions-28, J-identity-13 #3 to #5): the person's own compromised-account case.
 * Shapes and refusals: `@intafaced/contracts/identity-compromise`. Customer sessions only; an API key or sub-account
 * is refused. The case moves no money.
 */
import { protectedProcedure, router, TRPCError } from '@intafaced/contracts';
import {
  compromiseMineOutputSchema,
  compromiseReportInputSchema,
  compromiseReportOutputSchema,
  compromiseReviewInputSchema,
  compromiseReviewOutputSchema,
  compromiseStartInputSchema,
  compromiseStartOutputSchema,
} from '@intafaced/contracts/identity-compromise';
import { AuthError, type AuthService } from '../auth/auth-service.js';
import { factorActor } from '../auth/factor-gate.js';
import { toTrpcError } from '../router.js';
import { userCopy } from '../user-copy.js';
import { CompromiseError } from './compromise.js';

function toTrpc(err: unknown): never {
  if (err instanceof CompromiseError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: userCopy(err.code), cause: err });
  }
  if (err instanceof AuthError && err.code === 'auth.invalid_credentials') {
    throw new TRPCError({ code: 'FORBIDDEN', message: userCopy(err.code), cause: err });
  }
  throw toTrpcError(err);
}

export function createCompromiseRouter(auth: AuthService, privilegedUserIds: readonly string[]) {
  return router({
    /** Ends every session and key, freezes the account and opens one case; again while it is open, the same case. */
    start: protectedProcedure
      .input(compromiseStartInputSchema)
      .output(compromiseStartOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          const opened = await auth.startCompromise({
            userId: ctx.principal.userId,
            actor: factorActor(ctx.principal, privilegedUserIds),
            password: input.password,
          });
          return { caseId: opened.caseId, openedAt: opened.openedAt.toISOString(), changed: opened.changed };
        } catch (err) {
          toTrpc(err);
        }
      }),

    mine: protectedProcedure.output(compromiseMineOutputSchema).query(async ({ ctx }) => {
      try {
        return { case: await auth.compromiseCase(ctx.principal.userId, factorActor(ctx.principal, privilegedUserIds)) };
      } catch (err) {
        toTrpc(err);
      }
    }),

    reportStolenFunds: protectedProcedure
      .input(compromiseReportInputSchema)
      .output(compromiseReportOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await auth.reportStolenFunds({
            userId: ctx.principal.userId,
            actor: factorActor(ctx.principal, privilegedUserIds),
            body: input.body,
            clientRequestId: input.clientRequestId,
          });
        } catch (err) {
          toTrpc(err);
        }
      }),

    markReviewed: protectedProcedure
      .input(compromiseReviewInputSchema)
      .output(compromiseReviewOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          const done = await auth.markCompromiseReviewed({
            userId: ctx.principal.userId,
            actor: factorActor(ctx.principal, privilegedUserIds),
            item: input.item,
          });
          return { item: done.item, reviewedAt: done.reviewedAt.toISOString() };
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
