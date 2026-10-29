import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { revokeAllApiKeys, RevokeAllApiKeysError, revokeCauseOf } from './auth/revoke-all-api-keys.js';

/**
 * Top-level revoke-all (not nested under apiKeys) so mergeRouters cannot
 * replace apiKeys.exchange. identity:write. Named userId required.
 */
export function createApiKeyRevokeAllRouter(sql: Sql) {
  return router({
    revokeAllApiKeys: scopedProcedure('identity:write')
      .input(z.object({ userId: z.string().guid() }))
      .output(z.object({ userId: z.string().guid(), revoked: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await revokeAllApiKeys(sql, ctx.principal.userId, input.userId, revokeCauseOf(ctx.principal));
        } catch (err) {
          if (err instanceof RevokeAllApiKeysError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw err;
        }
      }),
  });
}
