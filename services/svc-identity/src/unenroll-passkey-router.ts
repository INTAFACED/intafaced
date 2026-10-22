import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { UnenrollPasskeyError } from './auth/unenroll-passkey.js';
import { unenrollOneOfTwo } from './auth/unenroll-one-of-two.js';

/**
 * Top-level unenroll (not nested under webauthn) so mergeRouters cannot replace
 * enroll/verify. identity:write. Drops one stored cred. Remaining creds keep
 * live seats and live API keys. Last cred still revokes. No invented challenge.
 */
export function createUnenrollPasskeyRouter(sql: Sql) {
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
          return await unenrollOneOfTwo(sql, ctx.principal.userId, input.credentialId);
        } catch (err) {
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
