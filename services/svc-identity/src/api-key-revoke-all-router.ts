import { router, TRPCError } from '@intafaced/contracts/trpc';
import type { Sql } from 'postgres';
import { revokeAllApiKeys, RevokeAllApiKeysError, revokeCauseOf } from './auth/revoke-all-api-keys.js';
import { IDENTITY_REVOKE_ALL_API_KEYS } from '@intafaced/contracts/identity-revoke-all-api-keys-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from './record-refusal.js';

/**
 * Top-level revoke-all (not nested under apiKeys) so mergeRouters cannot
 * replace apiKeys.exchange. identity:write. Named userId required.
 */
export function createApiKeyRevokeAllRouter(sql: Sql) {
  return router({
    revokeAllApiKeys: mountRecord(
      IDENTITY_REVOKE_ALL_API_KEYS,
      async ({ ctx, input }) => {
        try {
          return await revokeAllApiKeys(sql, ctx.principal.userId, input.userId, revokeCauseOf(ctx.principal));
        } catch (err) {
          if (err instanceof RevokeAllApiKeysError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw err;
        }
      },
      codedRefusal,
    ),
  });
}
