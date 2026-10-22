import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { beginVerifyPasskey, verifyPasskey, VerifyPasskeyError, sqlPasskeyChallenges } from './auth/verify-passkey.js';
import type { PasskeyRp } from './auth/enroll-passkey.js';

const authenticationResponse = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().optional(),
  }),
  clientExtensionResults: z.record(z.unknown()).optional(),
});

/**
 * Top-level verify (not nested under webauthn). identity:write.
 * Refuse if no enrolled credential. No invented challenge.
 */
export function createVerifyPasskeyRouter(sql: Sql, rp: PasskeyRp) {
  const challenges = sqlPasskeyChallenges(sql);
  return router({
    beginVerifyPasskey: scopedProcedure('identity:write').mutation(async ({ ctx }) => {
      try {
        return await beginVerifyPasskey(sql, ctx.principal.userId, rp, challenges);
      } catch (err) {
        if (err instanceof VerifyPasskeyError) {
          if (err.code === 'auth.not_found') {
            throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
          }
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
        }
        throw err;
      }
    }),
    verifyPasskey: scopedProcedure('identity:write')
      .input(authenticationResponse)
      .output(z.object({ credentialId: z.string(), verified: z.literal(true) }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await verifyPasskey(sql, ctx.principal.userId, rp, input, challenges);
        } catch (err) {
          if (err instanceof VerifyPasskeyError) {
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
