/**
 * `account.compromised.*` (I-signin-sessions-28, J-identity-13 #3 to #5): the person's own compromised-account case.
 * Shapes and refusals: `@intafaced/contracts/identity-compromise`. Customer sessions only; an API key or sub-account
 * is refused. The case moves no money.
 */
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { AuthError, type AuthService } from '../auth/auth-service.js';
import { factorActor } from '../auth/factor-gate.js';
import { toTrpcError } from '../router.js';
import { userCopy } from '../user-copy.js';
import { CompromiseError } from './compromise.js';
import {
  IDENTITY_ACCOUNT_COMPROMISED_MARK_REVIEWED,
  IDENTITY_ACCOUNT_COMPROMISED_MINE,
  IDENTITY_ACCOUNT_COMPROMISED_START,
  IDENTITY_ACCOUNT_COMPROMISED_REPORT_STOLEN_FUNDS,
} from '@intafaced/contracts/identity-account-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from '../record-refusal.js';

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
    start: mountRecord(
      IDENTITY_ACCOUNT_COMPROMISED_START,
      async ({ ctx, input }) => {
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
      },
      codedRefusal,
    ),

    mine: mountRecord(
      IDENTITY_ACCOUNT_COMPROMISED_MINE,
      async ({ ctx }) => {
        try {
          return { case: await auth.compromiseCase(ctx.principal.userId, factorActor(ctx.principal, privilegedUserIds)) };
        } catch (err) {
          toTrpc(err);
        }
      },
      codedRefusal,
    ),

    reportStolenFunds: mountRecord(
      IDENTITY_ACCOUNT_COMPROMISED_REPORT_STOLEN_FUNDS,
      async ({ ctx, input }) => {
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
      },
      codedRefusal,
    ),

    markReviewed: mountRecord(
      IDENTITY_ACCOUNT_COMPROMISED_MARK_REVIEWED,
      async ({ ctx, input }) => {
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
      },
      codedRefusal,
    ),
  });
}
