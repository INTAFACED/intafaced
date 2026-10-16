import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AuthError, assertDelegateCannotGrant } from './auth/auth-service.js';
import { ApiKeyRequestSignError, setApiKeyRequestSigning } from './auth/api-key-request-sign.js';

/**
 * Top-level opt-in (not nested under apiKeys) so mergeRouters cannot replace
 * apiKeys.exchange. identity:write. The caller must own the key. The signing
 * secret is returned only on the call that first turns signing on.
 */
export function createApiKeyRequestSignRouter(sql: Sql) {
  return router({
    setApiKeyRequestSigning: scopedProcedure('identity:write')
      .input(
        z.object({
          keyId: z.string().uuid(),
          requireSignature: z.boolean(),
          requireNonEmptyIpAllowlist: z.boolean(),
        }),
      )
      .output(
        z.object({
          id: z.string().uuid(),
          requireSignature: z.boolean(),
          requireNonEmptyIpAllowlist: z.boolean(),
          signingSecret: z.string().nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          return await setApiKeyRequestSigning(sql, ctx.principal.userId, input.keyId, {
            requireSignature: input.requireSignature,
            requireNonEmptyIpAllowlist: input.requireNonEmptyIpAllowlist,
          });
        } catch (err) {
          if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
            throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
          }
          if (err instanceof ApiKeyRequestSignError && err.reason === 'auth.not_found') {
            throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
          }
          throw err;
        }
      }),
  });
}
