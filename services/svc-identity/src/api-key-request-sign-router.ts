import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AuthError, assertDelegateCannotGrant } from './auth/auth-service.js';
import { optionalFactorProof, guardedApiKeyAction, type ApiKeyFactorGate } from './auth/api-key-fresh-factor.js';
import { ApiKeyRequestSignError, rotateSigningSecret, setApiKeyRequestSigning } from './auth/api-key-request-sign.js';

/**
 * Top-level opt-in (not nested under apiKeys) so mergeRouters cannot replace
 * apiKeys.exchange. identity:write. The caller must own the key. The signing
 * secret is returned only on the call that first turns signing on.
 */
function mapSignError(err: unknown): never {
  if (err instanceof AuthError && err.code === 'auth.delegate_cannot_grant') {
    throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
  }
  if (err instanceof ApiKeyRequestSignError && err.reason === 'auth.not_found') {
    throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof ApiKeyRequestSignError && (err.reason === 'auth.not_configured' || err.reason === 'auth.signature_not_required')) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  throw err;
}

export function createApiKeyRequestSignRouter(sql: Sql, gate: ApiKeyFactorGate, encKey: Buffer | null = null) {
  return router({
    setApiKeyRequestSigning: scopedProcedure('identity:write')
      .input(
        z.object({
          keyId: z.string().uuid(),
          requireSignature: z.boolean(),
          requireNonEmptyIpAllowlist: z.boolean(),
          factorProof: optionalFactorProof,
        }),
      )
      .output(
        z.object({
          id: z.string().uuid(),
          requireSignature: z.boolean(),
          requireNonEmptyIpAllowlist: z.boolean(),
          signingSecret: z.string().nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          const set = (db: Sql) =>
            setApiKeyRequestSigning(
              db,
              ctx.principal.userId,
              input.keyId,
              {
                requireSignature: input.requireSignature,
                requireNonEmptyIpAllowlist: input.requireNonEmptyIpAllowlist,
              },
              encKey,
            );
          // Turning signing on can reveal a secret: that needs a fresh factor. Turning it off or
          // leaving it off reveals nothing and stays one click.
          if (!input.requireSignature) return await set(sql);
          return await guardedApiKeyAction(
            gate,
            ctx.principal,
            input.factorProof,
            { action: 'signing_secret', keyId: input.keyId },
            (scope) => set(scope.tx),
          );
        } catch (err) {
          mapSignError(err);
        }
      }),
    /**
     * Replace the HMAC secret without turning the requirement off.
     * One transaction, so the key never accepts an unsigned call in between.
     * The new secret is returned once. identity:write, and the caller must own the key.
     */
    rotateSigningSecret: scopedProcedure('identity:write')
      .input(z.object({ keyId: z.string().uuid(), factorProof: optionalFactorProof }))
      .output(z.object({ id: z.string().uuid(), signingSecret: z.string() }))
      .mutation(async ({ ctx, input }) => {
        try {
          assertDelegateCannotGrant(ctx.principal.kid);
          return await guardedApiKeyAction(
            gate,
            ctx.principal,
            input.factorProof,
            { action: 'signing_secret', keyId: input.keyId },
            (scope) => rotateSigningSecret(scope.tx, ctx.principal.userId, input.keyId, encKey),
          );
        } catch (err) {
          mapSignError(err);
        }
      }),
  });
}
