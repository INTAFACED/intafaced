import { z } from 'zod';
import { scopedProcedure, supportWithdrawalFreezeResultSchema } from '@intafaced/contracts';
import { requireSupportOps } from './support-service.js';
import type { WithdrawalFreezes } from './withdrawal-freeze.js';

/**
 * `requestWithdrawalFreeze` (J-support-public-20 #7): the desk's (`support:ops`) only, by request. svc-identity records
 * the freeze; the answer is its record. There is no procedure that lifts it.
 */
export function withdrawalFreezeProcedures(freezes: WithdrawalFreezes, mapError: (err: unknown) => never) {
  return {
    requestWithdrawalFreeze: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid(), reason: z.string().trim().min(1).max(500) }).strict())
      .output(supportWithdrawalFreezeResultSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal);
          return await freezes.request(ctx.principal.userId, input);
        } catch (err) {
          mapError(err);
        }
      }),
  };
}
