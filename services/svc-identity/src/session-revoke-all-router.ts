import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { revokeAllSessions, RevokeAllSessionsError } from './auth/revoke-all-sessions.js';

/**
 * Top-level revoke-all (not nested under auth) so mergeRouters cannot
 * replace auth.logout. identity:write. Named userId required.
 */
export function createSessionRevokeAllRouter(sql: Sql) {
  return router({
    revokeAllSessions: scopedProcedure('identity:write')
      .input(z.object({ userId: z.string().guid() }))
      .output(z.object({ userId: z.string().guid(), revoked: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await revokeAllSessions(sql, ctx.principal.userId, input.userId);
        } catch (err) {
          if (err instanceof RevokeAllSessionsError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw err;
        }
      }),
  });
}
