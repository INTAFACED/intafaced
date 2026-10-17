import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AuthError, assertDelegateCannotGrant } from './auth/auth-service.js';
import { ApiKeyIpError, bindApiKeyIpAllowlist } from './auth/auth-service-ip.js';
import { unbindApiKeyIpAllowlist } from './auth/unbind-api-key-ip.js';
import { mintApiKeyWithIpAllowlist, type ApiKeyMinter } from './auth/mint-api-key-ip.js';

/**
 * Top-level bind / unbind / mint (not nested under apiKeys) so mergeRouters cannot
 * replace apiKeys.exchange. identity:write. Invalid IPs refuse.
 */
export function createApiKeyIpRouter(sql: Sql, minter: ApiKeyMinter) {
  return router({
    bindApiKeyIpAllowlist: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().uuid(), ips: z.array(z.string()) }))
      .output(
        z.object({
          id: z.string().uuid(),
          ipAllowlist: z.array(z.string()),
          requireSignature: z.boolean(),
          requireNonEmptyIpAllowlist: z.boolean(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          return await bindApiKeyIpAllowlist(sql, ctx.principal.userId, input.keyId, input.ips);
        } catch (err) {
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
      .input(z.object({ keyId: z.string().uuid(), ip: z.string() }))
      .output(
        z.object({
          id: z.string().uuid(),
          ipAllowlist: z.array(z.string()),
          requireSignature: z.boolean(),
          requireNonEmptyIpAllowlist: z.boolean(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          return await unbindApiKeyIpAllowlist(sql, ctx.principal.userId, input.keyId, input.ip);
        } catch (err) {
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
          assertDelegateCannotGrant(ctx.principal.kid);
          return await mintApiKeyWithIpAllowlist(minter, sql, {
            userId: ctx.principal.userId,
            name: input.name,
            scopes: input.scopes,
            grantorScopes: ctx.principal.scopes,
            grantorKid: ctx.principal.kid,
            ips: input.ips,
            domainWhitelist: input.domainWhitelist,
            mode: input.mode,
          });
        } catch (err) {
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
