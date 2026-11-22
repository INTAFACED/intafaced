import { z } from 'zod';
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { founderProcedure, type Founders } from './founder-procedure.js';
import { AuthKeyError, type AuthKeyRing } from './auth/auth-key-ring.js';
import { stateOut } from '@intafaced/contracts/identity-call-schemas';
import { IDENTITY_AUTH_KEYS_STATE } from '@intafaced/contracts/identity-auth-keys-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from './record-refusal.js';

const approval = {
  approvalId: z.string().min(1).max(128),
  operationId: z.string().min(1).max(128),
};

/**
 * Founder-ops signing-key rotation (/identity-ops/keys). Only a live founder on an interactive
 * second-factor session may read or change it; rotate and remove-old also consume a four-eyes approval.
 * Key material is never returned or logged: only ids.
 */
export function createAuthKeysRouter(ring: AuthKeyRing, founders: Founders) {
  const founder = founderProcedure(founders);
  const map = (err: unknown): never => {
    if (err instanceof AuthKeyError)
      throw new TRPCError({
        code: err.code === 'auth_key.approval_required' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST',
        message: err.code,
        cause: err,
      });
    throw err;
  };

  return router({
    authKeys: router({
      state: mountRecord(IDENTITY_AUTH_KEYS_STATE, () => ring.state(), { refusalOf: codedRefusal, founder }),
      rotate: founder
        .input(z.object({ keyId: z.string().min(1).max(32), ...approval }).strict())
        .output(stateOut)
        .mutation(({ ctx, input }) => ring.rotate({ ...input, actorId: ctx.principal.userId }).catch(map)),
      removeOld: founder
        .input(z.object(approval).strict())
        .output(stateOut)
        .mutation(({ ctx, input }) => ring.removeOld({ ...input, actorId: ctx.principal.userId }).catch(map)),
    }),
  });
}
