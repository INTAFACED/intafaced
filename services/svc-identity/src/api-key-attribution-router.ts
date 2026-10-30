import { z } from 'zod';
import { publicProcedure, router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { AuthError, assertDelegateCannotGrant, type AuthService } from './auth/auth-service.js';
import { optionalFactorProof, guardedApiKeyAction } from './auth/api-key-fresh-factor.js';
import { ATTRIBUTION_MISSING, AttributionError, attributedSurfaces, requireAttribution } from './auth/four-eyes.js';
import { assertEdgeSignedRequest, requestSignAls, requestSignWireSchema } from './auth/api-key-request-sign.js';
import { userCopy } from './user-copy.js';

const stampView = z.object({
  sessionId: z.string().nullable(),
  apiKeyId: z.string().nullable(),
});

const surfacesView = z.object({
  order: stampView,
  fill: stampView,
  ledger: stampView,
});

function mapAttributionErr(err: unknown): never {
  if (err instanceof AttributionError) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `${err.message} [${err.code}]`,
      cause: err,
    });
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
    if (err.code === 'auth.account_frozen' || err.code === 'auth.delegate_cannot_grant') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: err.code === 'auth.delegate_cannot_grant' ? err.message : message,
        cause: err,
      });
    }
    if (err.code === 'auth.api_key_denied' || err.code === 'auth.api_key_revoked') {
      throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    }
    if (err.code === 'auth.not_found') {
      throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
    }
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof TRPCError) throw err;
  throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message, cause: err });
}

/**
 * Top-level mint / exchange / assert attribution (not nested under apiKeys)
 * so mergeRouters cannot replace apiKeys.exchange. Hitch uses four-eyes
 * stampAttribution — missing session AND API-key is attribution_missing.
 * Signed-out is a named refuse, not an empty stamp.
 */
export function createApiKeyAttributionRouter(auth: AuthService) {
  return router({
    attribution: router({
      /**
       * Public: caller names session and/or API-key. Both missing → 412.
       * Trade persists the three surfaces; identity does not write ledger.
       */
      stamp: publicProcedure
        .input(z.object({ sessionId: z.string().optional(), apiKeyId: z.string().optional() }))
        .output(surfacesView)
        .mutation(({ input }) => {
          try {
            return attributedSurfaces(requireAttribution({ sessionId: input.sessionId, apiKeyId: input.apiKeyId }));
          } catch (err) {
            mapAttributionErr(err);
          }
        }),

      mint: scopedProcedure('identity:write')
        .input(
          z.object({
            name: z.string().min(1).max(64),
            scopes: z.array(z.string()).min(1),
            domainWhitelist: z.array(z.string()).optional(),
            mode: z.enum(['live', 'sandbox']).optional(),
            factorProof: optionalFactorProof,
          }),
        )
        .output(
          z.object({
            id: z.string(),
            key: z.string(),
            prefix: z.string(),
            mode: z.enum(['live', 'sandbox']),
            attribution: surfacesView,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          try {
            assertDelegateCannotGrant(ctx.principal.kid);
            return await guardedApiKeyAction(
              auth,
              ctx.principal,
              input.factorProof,
              { action: 'create', scopes: input.scopes },
              async (scope) => {
                const minted = await scope.createApiKey({
                  userId: ctx.principal.userId,
                  name: input.name,
                  scopes: input.scopes,
                  domainWhitelist: input.domainWhitelist,
                  mode: input.mode,
                  grantorScopes: ctx.principal.scopes,
                  grantorKid: ctx.principal.kid,
                });
                const stamp = requireAttribution({
                  sessionId: ctx.principal.sid,
                  apiKeyId: minted.id,
                });
                return { ...minted, attribution: attributedSurfaces(stamp) };
              },
            );
          } catch (err) {
            mapAttributionErr(err);
          }
        }),

      exchange: publicProcedure
        .input(z.object({ key: z.string().min(8).max(200), request: requestSignWireSchema.optional() }))
        .output(
          z.object({
            accessToken: z.string(),
            expiresAt: z.string(),
            userId: z.string().guid(),
            keyId: z.string().guid(),
            scopes: z.array(z.string()),
            mode: z.enum(['live', 'sandbox']),
            attribution: surfacesView,
          }),
        )
        .mutation(async ({ input, ctx }) => {
          try {
            assertEdgeSignedRequest(ctx.service, input.request);
            const clientOrigin = (ctx as { clientOrigin?: string }).clientOrigin;
            const result = await requestSignAls.run(input.request, () => auth.exchangeApiKey(input.key, clientOrigin));
            const stamp = requireAttribution({ apiKeyId: result.keyId });
            return {
              accessToken: result.accessToken,
              expiresAt: result.expiresAt.toISOString(),
              userId: result.userId,
              keyId: result.keyId,
              scopes: result.scopes,
              mode: result.mode,
              attribution: attributedSurfaces(stamp),
            };
          } catch (err) {
            mapAttributionErr(err);
          }
        }),

      assert: publicProcedure
        .input(z.object({ keyId: z.string().optional(), sessionId: z.string().optional() }))
        .output(
          z.object({
            id: z.string().nullable(),
            userId: z.string().nullable(),
            attribution: surfacesView,
          }),
        )
        .mutation(async ({ input }) => {
          try {
            const stamp = requireAttribution({ sessionId: input.sessionId, apiKeyId: input.keyId });
            if (stamp.apiKeyId) {
              const live = await auth.assertApiKeyLive(stamp.apiKeyId);
              return { id: live.id, userId: live.userId, attribution: attributedSurfaces(stamp) };
            }
            return { id: stamp.sessionId, userId: null, attribution: attributedSurfaces(stamp) };
          } catch (err) {
            mapAttributionErr(err);
          }
        }),
    }),
  });
}

export { ATTRIBUTION_MISSING };
