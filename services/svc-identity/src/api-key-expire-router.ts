import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AuthError, assertDelegateCannotGrant } from './auth/auth-service.js';
import { expireApiKey, ExpireApiKeyError } from './auth/expire-api-key.js';

/**
 * Top-level expire (not nested under apiKeys) so mergeRouters cannot
 * replace apiKeys.exchange. identity:write. expiresAt required. No invented clock.
 */
export function createApiKeyExpireRouter(sql: Sql) {
  return router({
    expireApiKey: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().uuid(), expiresAt: z.string() }))
      .output(z.object({ id: z.string(), expiresAt: z.string() }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          const out = await expireApiKey(sql, ctx.principal.userId, input.keyId, input.expiresAt);
          return { id: out.id, expiresAt: out.expiresAt.toISOString() };
        } catch (err) {
          if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
            throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
          }
          if (err instanceof ExpireApiKeyError) {
            if (err.code === 'auth.not_found') {
              throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
            }
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw err;
        }
      }),
  });
}
