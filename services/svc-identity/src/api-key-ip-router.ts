import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AuthError, assertDelegateCannotGrant } from './auth/auth-service.js';
import { ApiKeyIpError, bindApiKeyIpAllowlist } from './auth/auth-service-ip.js';
import { unbindApiKeyIpAllowlist } from './auth/unbind-api-key-ip.js';
import { narrowsAllowlist, optionalFactorProof, guardedApiKeyAction, type ApiKeyFactorGate } from './auth/api-key-fresh-factor.js';
import { normalizeIp } from './auth/api-key-ip.js';
import { mintApiKeyWithIpAllowlist, type ApiKeyMinter } from './auth/mint-api-key-ip.js';

async function currentList(sql: Sql, userId: string, keyId: string): Promise<string[]> {
  const rows = await sql<Array<{ ip_allowlist: string[] | null }>>`
    SELECT ip_allowlist FROM api_keys WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false
  `;
  return rows[0]?.ip_allowlist ?? [];
}

/**
 * Top-level bind / unbind / mint (not nested under apiKeys) so mergeRouters cannot
 * replace apiKeys.exchange. identity:write. Invalid IPs refuse.
 */
export function createApiKeyIpRouter(sql: Sql, minter: ApiKeyMinter, gate: ApiKeyFactorGate) {
  return router({
    bindApiKeyIpAllowlist: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().uuid(), ips: z.array(z.string()), factorProof: optionalFactorProof }))
      .output(z.object({ id: z.string().uuid(), ipAllowlist: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          const current = await currentList(sql, ctx.principal.userId, input.keyId);
          const next = input.ips.map((ip) => normalizeIp(ip) ?? ip);
          if (narrowsAllowlist(current, next)) return await bindApiKeyIpAllowlist(sql, ctx.principal.userId, input.keyId, input.ips);
          return await guardedApiKeyAction(
            gate,
            ctx.principal,
            input.factorProof,
            { action: 'ip_allowlist_widen', keyId: input.keyId },
            (scope) => bindApiKeyIpAllowlist(scope.tx, ctx.principal.userId, input.keyId, input.ips),
          );
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
      .input(z.object({ keyId: z.string().uuid(), ip: z.string(), factorProof: optionalFactorProof }))
      .output(z.object({ id: z.string().uuid(), ipAllowlist: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          const current = await currentList(sql, ctx.principal.userId, input.keyId);
          const ip = normalizeIp(input.ip);
          const next = current.filter((entry) => normalizeIp(entry) !== ip);
          if (narrowsAllowlist(current, next)) return await unbindApiKeyIpAllowlist(sql, ctx.principal.userId, input.keyId, input.ip);
          return await guardedApiKeyAction(
            gate,
            ctx.principal,
            input.factorProof,
            { action: 'ip_allowlist_widen', keyId: input.keyId },
            (scope) => unbindApiKeyIpAllowlist(scope.tx, ctx.principal.userId, input.keyId, input.ip),
          );
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
          factorProof: optionalFactorProof,
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
          return await guardedApiKeyAction(gate, ctx.principal, input.factorProof, { action: 'create', scopes: input.scopes }, (scope) =>
            mintApiKeyWithIpAllowlist(scope, scope.tx, {
              userId: ctx.principal.userId,
              name: input.name,
              scopes: input.scopes,
              grantorScopes: ctx.principal.scopes,
              grantorKid: ctx.principal.kid,
              ips: input.ips,
              domainWhitelist: input.domainWhitelist,
              mode: input.mode,
            }),
          );
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
          if (err instanceof TRPCError) throw err;
          throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message, cause: err });
        }
      }),
  });
}
