import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AuthError } from './auth/auth-service.js';
import type { ApiKeyMinter } from './auth/mint-api-key-ip.js';
import { rotateApiKey, RotateApiKeyError } from './auth/rotate-api-key.js';
import {
  apiKeyFactorProofSchema,
  assertKeyGrantor,
  requireFreshApiKeyFactor,
  rethrowApiKeyDoor,
  type FreshFactorVerifier,
} from './auth/api-key-fresh-factor.js';

/**
 * Top-level rotate (not nested under apiKeys) so mergeRouters cannot
 * replace apiKeys.exchange. identity:write. No invented secret.
 */
export function createApiKeyRotateRouter(sql: Sql, minter: ApiKeyMinter & FreshFactorVerifier, encKey: Buffer | null = null) {
  return router({
    rotateApiKey: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().uuid(), factorProof: apiKeyFactorProofSchema.optional() }))
      .output(
        z.object({
          id: z.string(),
          key: z.string(),
          prefix: z.string(),
          mode: z.enum(['live', 'sandbox']),
          revokedKeyId: z.string(),
          signingSecret: z.string().nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          assertKeyGrantor(ctx.principal);
          const factor = await requireFreshApiKeyFactor(minter, ctx.principal, input.factorProof);
          return await rotateApiKey(
            minter,
            sql,
            {
              userId: ctx.principal.userId,
              keyId: input.keyId,
              grantorScopes: ctx.principal.scopes,
              grantorKid: ctx.principal.kid,
              stepUpScopes: ctx.principal.stp,
              stepUpAudit: { sessionId: ctx.principal.sid, factor },
            },
            encKey,
          );
        } catch (err) {
          rethrowApiKeyDoor(err);
          if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
            throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
          }
          if (err instanceof RotateApiKeyError && err.code === 'auth.not_configured') {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
          }
          if (err instanceof RotateApiKeyError) {
            throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
          }
          throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message, cause: err });
        }
      }),
  });
}
