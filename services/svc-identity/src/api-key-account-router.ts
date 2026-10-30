import { z } from 'zod';
import { publicProcedure, router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ApiKeyAccountError } from './auth/api-key-account.js';
import { AuthError, assertDelegateCannotGrant } from './auth/auth-service.js';
import { optionalFactorProof, guardedApiKeyAction, type ApiKeyFactorGate } from './auth/api-key-fresh-factor.js';
import { assertApiKeyAccount, bindApiKeyAccount, requestAccountAls } from './auth/bind-api-key-account.js';
import { assertEdgeSignedRequest, requestSignAls, requestSignWireSchema } from './auth/api-key-request-sign.js';
import { mintApiKeyBoundToAccount } from './auth/mint-api-key-account.js';
import type { ApiKeyMinter } from './auth/mint-api-key-ip.js';
import { userCopy } from './user-copy.js';

type AccountExchanger = ApiKeyMinter & {
  exchangeApiKey(
    key: string,
    requestOrigin?: string | null,
  ): Promise<{
    accessToken: string;
    expiresAt: Date;
    userId: string;
    keyId: string;
    scopes: string[];
    mode: 'live' | 'sandbox';
    requireSignature?: boolean;
    requireNonEmptyIpAllowlist?: boolean;
    ipAllowlist?: string[];
  }>;
};

function toAccountTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof ApiKeyAccountError) {
    if (err.code === 'auth.not_found') {
      throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
    }
    if (err.code === 'auth.account_mismatch' || err.code === 'auth.account_denied' || err.code === 'auth.account_revoked') {
      throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    }
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof AuthError) {
    const message = userCopy(err.code);
    if (
      err.code === 'auth.invalid_credentials' ||
      err.code === 'auth.domain_not_allowed' ||
      err.code === 'auth.request_unsigned' ||
      err.code === 'auth.request_stale' ||
      err.code === 'auth.request_future' ||
      err.code === 'auth.request_tampered' ||
      err.code === 'auth.request_replay' ||
      err.code === 'auth.ip_allowlist_required' ||
      err.code === 'auth.api_key_expired' ||
      err.code === 'auth.edge_unauthenticated'
    ) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message, cause: err });
    }
    if (err.code === 'auth.request_window_unset') {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });
    }
    if (err.code === 'auth.api_key_revoked') {
      throw new TRPCError({ code: 'FORBIDDEN', message, cause: err });
    }
    if (err.code === 'auth.account_frozen' || err.code === 'auth.sub_account_denied' || err.code === 'auth.delegate_cannot_grant') {
      throw new TRPCError({ code: 'FORBIDDEN', message: err.code === 'auth.delegate_cannot_grant' ? err.message : message, cause: err });
    }
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message, cause: err });
}

/**
 * Top-level mint / bind / assert / exchange-for-account (not nested under apiKeys)
 * so mergeRouters cannot replace apiKeys.exchange. identity:write except the
 * public named-account exchange. Empty account id refuses.
 */
export function createApiKeyAccountRouter(sql: Sql, minter: AccountExchanger, gate: ApiKeyFactorGate) {
  return router({
    bindApiKeyAccount: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().guid(), accountId: z.string().guid() }))
      .output(z.object({ id: z.string().guid(), accountId: z.string().guid() }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          return await bindApiKeyAccount(sql, ctx.principal.userId, input.keyId, input.accountId);
        } catch (err) {
          toAccountTrpc(err);
        }
      }),
    mintApiKeyBoundToAccount: scopedProcedure('identity:write')
      .input(
        z.object({
          name: z.string().min(1).max(64),
          scopes: z.array(z.string()).min(1),
          accountId: z.string().guid(),
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
          accountId: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          return await guardedApiKeyAction(gate, ctx.principal, input.factorProof, { action: 'create', scopes: input.scopes }, (scope) =>
            mintApiKeyBoundToAccount(scope, scope.tx, {
              userId: ctx.principal.userId,
              name: input.name,
              scopes: input.scopes,
              grantorScopes: ctx.principal.scopes,
              grantorKid: ctx.principal.kid,
              accountId: input.accountId,
              domainWhitelist: input.domainWhitelist,
              mode: input.mode,
            }),
          );
        } catch (err) {
          toAccountTrpc(err);
        }
      }),
    assertApiKeyAccount: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().guid(), accountId: z.string().guid() }))
      .output(z.object({ id: z.string().guid(), accountId: z.string().guid() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await assertApiKeyAccount(sql, ctx.principal.userId, input.keyId, input.accountId);
        } catch (err) {
          toAccountTrpc(err);
        }
      }),
    /**
     * Public: long-lived key + named account → short-lived access JWT.
     * Bound keys must name the bound account. Empty account id refuses.
     */
    exchangeApiKeyForAccount: publicProcedure
      .input(
        z.object({
          key: z.string().min(8).max(200),
          accountId: z.string().guid(),
          request: requestSignWireSchema.optional(),
        }),
      )
      .output(
        z.object({
          accessToken: z.string(),
          expiresAt: z.string(),
          userId: z.string().guid(),
          keyId: z.string().guid(),
          scopes: z.array(z.string()),
          mode: z.enum(['live', 'sandbox']),
          accountId: z.string().guid(),
          requireSignature: z.boolean().optional(),
          requireNonEmptyIpAllowlist: z.boolean().optional(),
          ipAllowlist: z.array(z.string()).optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        try {
          assertEdgeSignedRequest(ctx.service, input.request);
          const clientOrigin = (ctx as { clientOrigin?: string }).clientOrigin;
          const result = await requestAccountAls.run(input.accountId, () =>
            requestSignAls.run(input.request, () => minter.exchangeApiKey(input.key, clientOrigin)),
          );
          return {
            accessToken: result.accessToken,
            expiresAt: result.expiresAt.toISOString(),
            userId: result.userId,
            keyId: result.keyId,
            scopes: result.scopes,
            mode: result.mode,
            accountId: input.accountId,
            ...(result.requireSignature === undefined ? {} : { requireSignature: result.requireSignature }),
            ...(result.requireNonEmptyIpAllowlist === undefined ? {} : { requireNonEmptyIpAllowlist: result.requireNonEmptyIpAllowlist }),
            ...(result.ipAllowlist === undefined ? {} : { ipAllowlist: result.ipAllowlist }),
          };
        } catch (err) {
          toAccountTrpc(err);
        }
      }),
  });
}
