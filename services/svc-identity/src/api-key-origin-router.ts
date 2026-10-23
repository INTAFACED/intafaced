import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AuthError } from './auth/auth-service.js';
import { originAllowlistWidens, normalizeOriginHost } from './auth/api-key-origin.js';
import { ApiKeyOriginError, bindApiKeyOriginAllowlist, loadApiKeyOriginAllowlist } from './auth/auth-service-origin.js';
import { unbindApiKeyOriginAllowlist } from './auth/unbind-api-key-origin.js';
import { mintApiKeyWithOriginAllowlist } from './auth/mint-api-key-origin.js';
import type { ApiKeyMinter } from './auth/mint-api-key-ip.js';
import {
  apiKeyFactorProofSchema,
  assertKeyGrantor,
  assertPayKeyScopes,
  requireFreshApiKeyFactor,
  rethrowApiKeyDoor,
  type FreshFactorVerifier,
} from './auth/api-key-fresh-factor.js';

/**
 * Top-level bind / unbind / mint (not nested under apiKeys) so mergeRouters cannot
 * replace apiKeys.exchange. identity:write. Invalid origins refuse.
 */
export function createApiKeyOriginRouter(sql: Sql, minter: ApiKeyMinter & FreshFactorVerifier) {
  return router({
    bindApiKeyOriginAllowlist: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().uuid(), origins: z.array(z.string()), factorProof: apiKeyFactorProofSchema.optional() }))
      .output(z.object({ id: z.string().uuid(), originAllowlist: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertKeyGrantor(ctx.principal);
          const current = await loadApiKeyOriginAllowlist(sql, ctx.principal.userId, input.keyId);
          if (current && originAllowlistWidens(current, input.origins)) {
            await requireFreshApiKeyFactor(minter, ctx.principal, input.factorProof);
          }
          return await bindApiKeyOriginAllowlist(sql, ctx.principal.userId, input.keyId, input.origins);
        } catch (err) {
          rethrowApiKeyDoor(err);
          if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
            throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
          }
          if (err instanceof ApiKeyOriginError) {
            if (err.code === 'auth.not_found') {
              throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
            }
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw err;
        }
      }),
    unbindApiKeyOriginAllowlist: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().uuid(), origin: z.string(), factorProof: apiKeyFactorProofSchema.optional() }))
      .output(z.object({ id: z.string().uuid(), originAllowlist: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertKeyGrantor(ctx.principal);
          const current = await loadApiKeyOriginAllowlist(sql, ctx.principal.userId, input.keyId);
          const host = normalizeOriginHost(input.origin);
          const next = host && current ? current.filter((entry) => normalizeOriginHost(entry) !== host) : (current ?? []);
          if (current && originAllowlistWidens(current, next)) {
            await requireFreshApiKeyFactor(minter, ctx.principal, input.factorProof);
          }
          return await unbindApiKeyOriginAllowlist(sql, ctx.principal.userId, input.keyId, input.origin);
        } catch (err) {
          rethrowApiKeyDoor(err);
          if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
            throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
          }
          if (err instanceof ApiKeyOriginError) {
            if (err.code === 'auth.not_found') {
              throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
            }
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw err;
        }
      }),
    mintApiKeyWithOriginAllowlist: scopedProcedure('identity:write')
      .input(
        z.object({
          name: z.string().min(1).max(64),
          scopes: z.array(z.string()).min(1),
          origins: z.array(z.string()),
          mode: z.enum(['live', 'sandbox']).optional(),
          factorProof: apiKeyFactorProofSchema.optional(),
        }),
      )
      .output(
        z.object({
          id: z.string(),
          key: z.string(),
          prefix: z.string(),
          mode: z.enum(['live', 'sandbox']),
          originAllowlist: z.array(z.string()),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          assertKeyGrantor(ctx.principal);
          const payStepUp = assertPayKeyScopes(input.scopes, ctx.principal);
          const factor = await requireFreshApiKeyFactor(minter, ctx.principal, input.factorProof);
          return await mintApiKeyWithOriginAllowlist(minter, sql, {
            userId: ctx.principal.userId,
            name: input.name,
            scopes: input.scopes,
            grantorScopes: ctx.principal.scopes,
            grantorKid: ctx.principal.kid,
            origins: input.origins,
            mode: input.mode,
            payStepUp,
            stepUpAudit: { sessionId: ctx.principal.sid, factor },
          });
        } catch (err) {
          rethrowApiKeyDoor(err);
          if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
            throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
          }
          if (err instanceof ApiKeyOriginError) {
            if (err.code === 'auth.not_found') {
              throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
            }
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message, cause: err });
        }
      }),
  });
}
