import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { panicRevoke, PanicRevokeError } from './auth/panic-revoke.js';
import { RevokeAllApiKeysError, revokeCauseOf } from './auth/revoke-all-api-keys.js';
import { RevokeAllSessionsError } from './auth/revoke-all-sessions.js';

/**
 * Top-level panic (not nested under apiKeys/auth) so mergeRouters cannot
 * replace those trees. identity:write. Named userId required.
 * Keys + sessions die in one move. Reuses the two existing revoke-all functions.
 */
export function createPanicRevokeRouter(sql: Sql) {
  return router({
    panicRevoke: scopedProcedure('identity:write')
      .input(z.object({ userId: z.string().guid() }))
      .output(
        z.object({
          userId: z.string().guid(),
          keysRevoked: z.number().int(),
          sessionsRevoked: z.number().int(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await panicRevoke(sql, ctx.principal.userId, input.userId, revokeCauseOf(ctx.principal));
        } catch (err) {
          if (err instanceof PanicRevokeError || err instanceof RevokeAllApiKeysError || err instanceof RevokeAllSessionsError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw err;
        }
      }),
  });
}
