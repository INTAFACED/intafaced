import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AuthError, assertDelegateCannotGrant } from './auth/auth-service.js';
import {
  narrowOrGuardedAllowlistChange,
  optionalFactorProof,
  guardedApiKeyAction,
  type ApiKeyFactorGate,
} from './auth/api-key-fresh-factor.js';
import { ApiKeyOriginError, bindApiKeyOriginAllowlist, normalizeOrigin } from './auth/auth-service-origin.js';
import { unbindApiKeyOriginAllowlist } from './auth/unbind-api-key-origin.js';
import { mintApiKeyWithOriginAllowlist } from './auth/mint-api-key-origin.js';
import type { ApiKeyMinter } from './auth/mint-api-key-ip.js';

async function currentList(sql: Sql, userId: string, keyId: string): Promise<string[]> {
  const rows = await sql<Array<{ domain_whitelist: string[] | null }>>`
    SELECT domain_whitelist FROM api_keys WHERE id = ${keyId} AND user_id = ${userId} AND revoked = false FOR UPDATE
  `;
  return rows[0]?.domain_whitelist ?? [];
}

/**
 * Top-level bind / unbind / mint (not nested under apiKeys) so mergeRouters cannot
 * replace apiKeys.exchange. identity:write. Invalid origins refuse.
 */
export function createApiKeyOriginRouter(sql: Sql, minter: ApiKeyMinter, gate: ApiKeyFactorGate) {
  return router({
    bindApiKeyOriginAllowlist: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().uuid(), origins: z.array(z.string()), factorProof: optionalFactorProof }))
      .output(z.object({ id: z.string().uuid(), originAllowlist: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          const next = input.origins.map((o) => normalizeOrigin(o) ?? o);
          return await narrowOrGuardedAllowlistChange({
            sql,
            gate,
            caller: ctx.principal,
            proof: input.factorProof,
            action: { action: 'origin_allowlist_widen', keyId: input.keyId },
            readLocked: (tx) => currentList(tx, ctx.principal.userId, input.keyId),
            nextFrom: (current) => next,
            write: (tx) => bindApiKeyOriginAllowlist(tx, ctx.principal.userId, input.keyId, input.origins),
          });
        } catch (err) {
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
      .input(z.object({ keyId: z.string().uuid(), origin: z.string(), factorProof: optionalFactorProof }))
      .output(z.object({ id: z.string().uuid(), originAllowlist: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          const origin = normalizeOrigin(input.origin);
          return await narrowOrGuardedAllowlistChange({
            sql,
            gate,
            caller: ctx.principal,
            proof: input.factorProof,
            action: { action: 'origin_allowlist_widen', keyId: input.keyId },
            readLocked: (tx) => currentList(tx, ctx.principal.userId, input.keyId),
            nextFrom: (current) => current.filter((entry) => normalizeOrigin(entry) !== origin),
            write: (tx) => unbindApiKeyOriginAllowlist(tx, ctx.principal.userId, input.keyId, input.origin),
          });
        } catch (err) {
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
          factorProof: optionalFactorProof,
          mode: z.enum(['live', 'sandbox']).optional(),
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
          assertDelegateCannotGrant(ctx.principal.kid);
          return await guardedApiKeyAction(gate, ctx.principal, input.factorProof, { action: 'create', scopes: input.scopes }, (scope) =>
            mintApiKeyWithOriginAllowlist(scope, scope.tx, {
              userId: ctx.principal.userId,
              name: input.name,
              scopes: input.scopes,
              grantorScopes: ctx.principal.scopes,
              grantorKid: ctx.principal.kid,
              origins: input.origins,
              mode: input.mode,
            }),
          );
        } catch (err) {
          if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
            throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
          }
          if (err instanceof ApiKeyOriginError) {
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
