import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import {
  beginEnrollPasskey,
  enrollPasskey,
  EnrollPasskeyError,
  sqlPasskeyChallenges,
  toRegistrationResponseJSON,
  type PasskeyRp,
} from './auth/enroll-passkey.js';
import { assertMayAddFactor, factorActor, factorGateTrpcError } from './auth/factor-gate.js';

const registrationResponse = z.object({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: z.string().min(1),
    attestationObject: z.string().min(1),
    transports: z.array(z.string()).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Top-level enroll (not nested under webauthn) so mergeRouters cannot replace
 * webauthn.registerVerify. identity:write. RP id/origin required. No invented secret.
 */
export function createEnrollPasskeyRouter(
  sql: Sql,
  rp: PasskeyRp,
  privilegedUserIds: readonly string[] = [],
  limits: { readonly maxPerAccount?: number | undefined } = {},
) {
  const challenges = sqlPasskeyChallenges(sql);
  return router({
    beginEnrollPasskey: scopedProcedure('identity:write').mutation(async ({ ctx }) => {
      try {
        await assertMayAddFactor(sql, ctx.principal.userId, factorActor(ctx.principal, privilegedUserIds), false);
        return await beginEnrollPasskey(sql, ctx.principal.userId, rp, challenges);
      } catch (err) {
        const gate = factorGateTrpcError(err);
        if (gate) throw gate;
        if (err instanceof EnrollPasskeyError) {
          if (err.code === 'auth.not_found') {
            throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
          }
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
        }
        throw err;
      }
    }),
    enrollPasskey: scopedProcedure('identity:write')
      .input(registrationResponse)
      .output(z.object({ credentialId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        try {
          // Unlocked pre-check: a fast refusal before the challenge is spent. The
          // authoritative check re-runs inside enrollPasskey's row-locked transaction.
          const actor = factorActor(ctx.principal, privilegedUserIds);
          await assertMayAddFactor(sql, ctx.principal.userId, actor, false);
          return await enrollPasskey(
            sql,
            ctx.principal.userId,
            rp,
            toRegistrationResponseJSON(input),
            challenges,
            actor,
            undefined,
            limits,
          );
        } catch (err) {
          const gate = factorGateTrpcError(err);
          if (gate) throw gate;
          if (err instanceof EnrollPasskeyError) {
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
