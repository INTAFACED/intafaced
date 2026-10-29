import { z } from 'zod';
import { router, scopedProcedure, TRPCError, type Context } from '@intafaced/contracts';
import { accountStatusSchema } from '@intafaced/contracts/identity-account-status';
import type { AccountStatusDesk } from './account-status.js';

/**
 * Staff reads are for a person at the console, as `listRestricted` is: never a service (the procedure's `person` guard),
 * an API key or a sub-account.
 */
function refuseNonOperator(ctx: Context): void {
  const p = ctx.principal;
  if (!p || p.kid || p.sub_account)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Staff reads need a person signed in', cause: { code: 'operator.denied' } });
}

/** A sub-account's own state lives with the sub-account, not here: its session is refused rather than shown the owner's. */
function refuseSubAccount(ctx: Context): void {
  if (ctx.principal?.sub_account)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Sign in to the main account to read its status',
      cause: { code: 'identity.delegated_refused' },
    });
}

/**
 * `account.status` (I-signin-sessions-22). `mine` answers the caller's own account and takes no user id; `of` is the
 * same shape for any account, for support and compliance (`admin:read`, a person signed in). Reads only. Mounted on its
 * own (`accountStatus`) so it shares no file with the `account.*` change doors.
 */
export function createAccountStatusRouter(desk: AccountStatusDesk) {
  const read = async (userId: string) => {
    const status = await desk.read(userId);
    if (!status) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found', cause: { code: 'auth.not_found' } });
    return status;
  };
  return router({
    accountStatus: router({
      mine: scopedProcedure('identity:read')
        .output(accountStatusSchema)
        .query(({ ctx }) => {
          refuseSubAccount(ctx);
          return read(ctx.principal.userId);
        }),
      of: scopedProcedure('admin:read', { person: true })
        .input(z.object({ userId: z.string().guid() }).strict())
        .output(accountStatusSchema)
        .query(({ ctx, input }) => {
          refuseNonOperator(ctx);
          return read(input.userId);
        }),
    }),
  });
}
