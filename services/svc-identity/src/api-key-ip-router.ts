import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AuthError } from './auth/auth-service.js';
import { ApiKeyIpError, bindApiKeyIpAllowlist, loadApiKeyIpAllowlist } from './auth/auth-service-ip.js';
import { ipAllowlistWidens, normalizeIp } from './auth/api-key-ip.js';
import { unbindApiKeyIpAllowlist } from './auth/unbind-api-key-ip.js';
import { mintApiKeyWithIpAllowlist, type ApiKeyMinter } from './auth/mint-api-key-ip.js';
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
 * replace apiKeys.exchange. identity:write. Invalid IPs refuse.
 */
export function createApiKeyIpRouter(sql: Sql, minter: ApiKeyMinter & FreshFactorVerifier) {
  return router({
    bindApiKeyIpAllowlist: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().uuid(), ips: z.array(z.string()), factorProof: apiKeyFactorProofSchema.optional() }))
      .output(z.object({ id: z.string().uuid(), ipAllowlist: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertKeyGrantor(ctx.principal);
          const current = await loadApiKeyIpAllowlist(sql, ctx.principal.userId, input.keyId);
          if (current && ipAllowlistWidens(current, input.ips)) {
            await requireFreshApiKeyFactor(minter, ctx.principal, input.factorProof);
          }
          return await bindApiKeyIpAllowlist(sql, ctx.principal.userId, input.keyId, input.ips);
        } catch (err) {
          rethrowApiKeyDoor(err);
          if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
            throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
          }
          if (err instanceof ApiKeyIpError) {
            if (err.code === 'auth.not_found') {
              throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
            }
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw err;
        }
      }),
    unbindApiKeyIpAllowlist: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().uuid(), ip: z.string(), factorProof: apiKeyFactorProofSchema.optional() }))
      .output(z.object({ id: z.string().uuid(), ipAllowlist: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertKeyGrantor(ctx.principal);
          const current = await loadApiKeyIpAllowlist(sql, ctx.principal.userId, input.keyId);
          const ip = normalizeIp(input.ip);
          const next = ip && current ? current.filter((entry) => normalizeIp(entry) !== ip) : (current ?? []);
          if (current && ipAllowlistWidens(current, next)) {
            await requireFreshApiKeyFactor(minter, ctx.principal, input.factorProof);
          }
          return await unbindApiKeyIpAllowlist(sql, ctx.principal.userId, input.keyId, input.ip);
        } catch (err) {
          rethrowApiKeyDoor(err);
          if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
            throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
          }
          if (err instanceof ApiKeyIpError) {
            if (err.code === 'auth.not_found') {
              throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
            }
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw err;
        }
      }),
    mintApiKeyWithIpAllowlist: scopedProcedure('identity:write')
      .input(
        z.object({
          name: z.string().min(1).max(64),
          scopes: z.array(z.string()).min(1),
          ips: z.array(z.string()),
          domainWhitelist: z.array(z.string()).optional(),
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
          ipAllowlist: z.array(z.string()),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          assertKeyGrantor(ctx.principal);
          const payStepUp = assertPayKeyScopes(input.scopes, ctx.principal);
          const factor = await requireFreshApiKeyFactor(minter, ctx.principal, input.factorProof);
          return await mintApiKeyWithIpAllowlist(minter, sql, {
            userId: ctx.principal.userId,
            name: input.name,
            scopes: input.scopes,
            grantorScopes: ctx.principal.scopes,
            grantorKid: ctx.principal.kid,
            ips: input.ips,
            domainWhitelist: input.domainWhitelist,
            mode: input.mode,
            payStepUp,
            stepUpAudit: { sessionId: ctx.principal.sid, factor },
          });
        } catch (err) {
          rethrowApiKeyDoor(err);
          if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
            throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
          }
          if (err instanceof ApiKeyIpError) {
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
