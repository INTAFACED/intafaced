import { router, TRPCError } from '@intafaced/contracts/trpc';
import type { Sql } from 'postgres';
import { factorStatus, FactorStatusError } from './auth/factor-status.js';
import { IDENTITY_FACTOR_STATUS } from '@intafaced/contracts/identity-factor-status-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from './record-refusal.js';

/**
 * Top-level `factorStatus` (I-signin-sessions-14): the caller's own sign-in methods and Security checklist. It takes no
 * input, so no one can ask about another account.
 */
export function createFactorStatusRouter(sql: Sql) {
  return router({
    factorStatus: mountRecord(
      IDENTITY_FACTOR_STATUS,
      async ({ ctx }) => {
        try {
          return await factorStatus(sql, ctx.principal.userId);
        } catch (err) {
          if (err instanceof FactorStatusError) throw new TRPCError({ code: 'NOT_FOUND', message: err.code, cause: err });
          throw err;
        }
      },
      codedRefusal,
    ),
  });
}
