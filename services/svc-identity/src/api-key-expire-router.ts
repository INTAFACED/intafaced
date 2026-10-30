import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AuthError, assertDelegateCannotGrant } from './auth/auth-service.js';
import { optionalFactorProof, type ApiKeyFactorGate } from './auth/api-key-fresh-factor.js';
import { expireApiKey, ExpireApiKeyError } from './auth/expire-api-key.js';
import { userCopy } from './user-copy.js';

/**
 * Top-level expire (not nested under apiKeys) so mergeRouters cannot
 * replace apiKeys.exchange. identity:write. expiresAt required. No invented clock.
 * The same writer as `developerKeys.setExpiry`: a nearer end date needs no factor, a later one a fresh one, and a
 * revoked or ended key never changes.
 */
export function createApiKeyExpireRouter(sql: Sql, gate: ApiKeyFactorGate) {
  return router({
    expireApiKey: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().guid(), expiresAt: z.string(), factorProof: optionalFactorProof }))
      .output(z.object({ id: z.string(), expiresAt: z.string() }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          const out = await expireApiKey({ sql, gate }, ctx.principal, input.keyId, input.expiresAt, input.factorProof);
          return { id: out.id, expiresAt: out.expiresAt.toISOString() };
        } catch (err) {
          if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
            throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
          }
          if (err instanceof ExpireApiKeyError) {
            if (err.code === 'auth.not_found') {
              throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
            }
            if (err.code === 'identity.key_not_live') {
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${userCopy(err.code)} [${err.code}]`, cause: err });
            }
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw err;
        }
      }),
  });
}
