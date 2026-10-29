import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { accountStatusSchema } from '@intafaced/contracts/identity-account-status';
import type { AccountStatusDesk } from './account-status.js';

/**
 * `account.status` (I-signin-sessions-22). `mine` answers the caller's own account and takes no user id; `of` is the
 * same shape for any account, for support and compliance (`admin:read`). Reads only.
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
        .query(({ ctx }) => read(ctx.principal.userId)),
      of: scopedProcedure('admin:read')
        .input(z.object({ userId: z.string().guid() }).strict())
        .output(accountStatusSchema)
        .query(({ input }) => read(input.userId)),
    }),
  });
}
