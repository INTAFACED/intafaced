import { z } from 'zod';
import { publicProcedure, router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { ApiKeyProductError } from './auth/api-key-product.js';
import { AuthError } from './auth/auth-service.js';
import {
  apiKeyFactorProofSchema,
  assertKeyGrantor,
  assertPayKeyScopes,
  requireFreshApiKeyFactor,
  rethrowApiKeyDoor,
  type FreshFactorVerifier,
} from './auth/api-key-fresh-factor.js';
import { bindApiKeyProductScope, requestProductAls } from './auth/auth-service-product.js';
import { assertEdgeSignedRequest, requestSignAls, requestSignWireSchema } from './auth/api-key-request-sign.js';
import { mintApiKeyWithProductScope } from './auth/mint-api-key-product.js';
import { unbindApiKeyProductScope } from './auth/unbind-api-key-product.js';
import type { ApiKeyMinter } from './auth/mint-api-key-ip.js';
import { userCopy } from './user-copy.js';

type ProductExchanger = ApiKeyMinter & {
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

function toProductTrpc(err: unknown): never {
  if (err instanceof ApiKeyProductError) {
    if (err.code === 'auth.not_found') {
      throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
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
      err.code === 'auth.request_tampered' ||
      err.code === 'auth.request_replay' ||
      err.code === 'auth.ip_allowlist_required'
    ) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message, cause: err });
    }
    if (err.code === 'auth.account_frozen' || err.code === 'auth.sub_account_denied' || err.code === 'auth.delegate_cannot_grant') {
      throw new TRPCError({ code: 'FORBIDDEN', message: err.code === 'auth.delegate_cannot_grant' ? err.message : message, cause: err });
    }
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message, cause: err });
}

/**
 * Top-level bind / unbind / mint / named-product exchange (not nested under
 * apiKeys) so mergeRouters cannot replace apiKeys.exchange. identity:write
 * except the public named-product exchange. Empty list stays unset.
 */
export function createApiKeyProductRouter(sql: Sql, minter: ProductExchanger & FreshFactorVerifier) {
  return router({
    bindApiKeyProductScope: scopedProcedure('identity:write')
      .input(
        z.object({
          keyId: z.string().uuid(),
          products: z.array(z.string()),
          factorProof: apiKeyFactorProofSchema.optional(),
        }),
      )
      .output(z.object({ id: z.string().uuid(), productScopes: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertKeyGrantor(ctx.principal);
          await requireFreshApiKeyFactor(minter, ctx.principal, input.factorProof);
          return await bindApiKeyProductScope(sql, ctx.principal.userId, input.keyId, input.products, ctx.principal.scopes);
        } catch (err) {
          rethrowApiKeyDoor(err);
          toProductTrpc(err);
        }
      }),
    unbindApiKeyProductScope: scopedProcedure('identity:write')
      .input(
        z.object({
          keyId: z.string().uuid(),
          product: z.string(),
          factorProof: apiKeyFactorProofSchema.optional(),
        }),
      )
      .output(z.object({ id: z.string().uuid(), productScopes: z.array(z.string()) }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertKeyGrantor(ctx.principal);
          await requireFreshApiKeyFactor(minter, ctx.principal, input.factorProof);
          return await unbindApiKeyProductScope(sql, ctx.principal.userId, input.keyId, input.product);
        } catch (err) {
          rethrowApiKeyDoor(err);
          toProductTrpc(err);
        }
      }),
    mintApiKeyWithProductScope: scopedProcedure('identity:write')
      .input(
        z.object({
          name: z.string().min(1).max(64),
          scopes: z.array(z.string()).min(1),
          products: z.array(z.string()),
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
          productScopes: z.array(z.string()),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          assertKeyGrantor(ctx.principal);
          const payStepUp = assertPayKeyScopes(input.scopes, ctx.principal);
          const factor = await requireFreshApiKeyFactor(minter, ctx.principal, input.factorProof);
          return await mintApiKeyWithProductScope(minter, sql, {
            userId: ctx.principal.userId,
            name: input.name,
            scopes: input.scopes,
            grantorScopes: ctx.principal.scopes,
            grantorKid: ctx.principal.kid,
            products: input.products,
            domainWhitelist: input.domainWhitelist,
            mode: input.mode,
            payStepUp,
            stepUpAudit: { sessionId: ctx.principal.sid, factor },
          });
        } catch (err) {
          rethrowApiKeyDoor(err);
          toProductTrpc(err);
        }
      }),
    /**
     * Public: long-lived key + named product → short-lived access JWT.
     * Bound keys must name a listed product. Empty list stays open.
     */
    exchangeApiKeyForProduct: publicProcedure
      .input(
        z.object({
          key: z.string().min(8).max(200),
          product: z.string().min(1).max(64),
          request: requestSignWireSchema.optional(),
        }),
      )
      .output(
        z.object({
          accessToken: z.string(),
          expiresAt: z.string(),
          userId: z.string().uuid(),
          keyId: z.string().uuid(),
          scopes: z.array(z.string()),
          mode: z.enum(['live', 'sandbox']),
          product: z.string(),
          requireSignature: z.boolean().optional(),
          requireNonEmptyIpAllowlist: z.boolean().optional(),
          ipAllowlist: z.array(z.string()).optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        try {
          assertEdgeSignedRequest(ctx.service, input.request);
          const clientOrigin = (ctx as { clientOrigin?: string }).clientOrigin;
          const result = await requestProductAls.run(input.product, () =>
            requestSignAls.run(input.request, () => minter.exchangeApiKey(input.key, clientOrigin)),
          );
          return {
            accessToken: result.accessToken,
            expiresAt: result.expiresAt.toISOString(),
            userId: result.userId,
            keyId: result.keyId,
            scopes: result.scopes,
            mode: result.mode,
            product: input.product,
            ...(result.requireSignature === undefined ? {} : { requireSignature: result.requireSignature }),
            ...(result.requireNonEmptyIpAllowlist === undefined ? {} : { requireNonEmptyIpAllowlist: result.requireNonEmptyIpAllowlist }),
            ...(result.ipAllowlist === undefined ? {} : { ipAllowlist: result.ipAllowlist }),
          };
        } catch (err) {
          toProductTrpc(err);
        }
      }),
  });
}
