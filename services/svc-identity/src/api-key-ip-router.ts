import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ApiKeyIpError, bindApiKeyIpAllowlist } from './auth/auth-service-ip.js';
import { unbindApiKeyIpAllowlist } from './auth/unbind-api-key-ip.js';

/**
 * Top-level bind / unbind (not nested under apiKeys) so mergeRouters cannot
 * replace apiKeys.exchange. identity:write. Invalid IPs refuse.
 */
export function createApiKeyIpRouter(sql: Sql) {
  return router({
    bindApiKeyIpAllowlist: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().uuid(), ips: z.array(z.string()) }))
      .output(z.object({ id: z.string().uuid(), ipAllowlist: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await bindApiKeyIpAllowlist(sql, ctx.principal.userId, input.keyId, input.ips);
        } catch (err) {
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
      .output(z.object({ id: z.string().uuid(), ipAllowlist: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await unbindApiKeyIpAllowlist(sql, ctx.principal.userId, input.keyId, input.ip);
        } catch (err) {
          if (err instanceof ApiKeyIpError) {
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
