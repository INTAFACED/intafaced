import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { UnenrollPasskeyError } from './auth/unenroll-passkey.js';
import { assertMayRemoveFactor, factorActor, factorGateTrpcError } from './auth/factor-gate.js';
import { unenrollOneOfTwo } from './auth/unenroll-one-of-two.js';
import { AuthError } from './auth/auth-service.js';
import { assertMayDropFactor } from './auth/merchant-mfa-last-factor.js';
import type { MerchantMfaRuleRead } from './auth/merchant-mfa-rule.js';
import { userCopy } from './user-copy.js';

/**
 * Top-level unenroll (not nested under webauthn) so mergeRouters cannot replace
 * enroll/verify. identity:write. Drops one stored cred. Remaining creds keep
 * live seats and live API keys. Last cred still revokes. No invented challenge.
 */
export function createUnenrollPasskeyRouter(sql: Sql, merchantMfaRule?: MerchantMfaRuleRead | null) {
  return router({
    unenrollPasskey: scopedProcedure('identity:write')
      .input(z.object({ credentialId: z.string().min(1) }))
      .output(
        z.object({
          credentialId: z.string(),
          remaining: z.number().int(),
          sessionsRevoked: z.number().int(),
          keysRevoked: z.number().int(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          // Removing a factor needs an MFA session, refused before any lookup.
          assertMayRemoveFactor(factorActor(ctx.principal));
          // M-plat-org-06: the last factor stays while a merchant this person is on requires MFA.
          await assertMayDropFactor(sql, merchantMfaRule, ctx.principal.userId, { kind: 'passkey', credentialId: input.credentialId });
          return await unenrollOneOfTwo(sql, ctx.principal.userId, input.credentialId);
        } catch (err) {
          const gate = factorGateTrpcError(err);
          if (gate) throw gate;
          if (err instanceof AuthError && err.code === 'auth.merchant_mfa_last_factor') {
            throw new TRPCError({ code: 'FORBIDDEN', message: userCopy(err.code), cause: err });
          }
          if (err instanceof AuthError && err.code === 'auth.merchant_mfa_rule_unavailable') {
            throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: userCopy(err.code), cause: err });
          }
          if (err instanceof UnenrollPasskeyError) {
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
