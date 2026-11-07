import { TRPCError } from '@trpc/server';
import {
  router,
  scopedProcedure,
  SUPPORT_BEREAVEMENT_DATE_INVALID,
  SUPPORT_SAFETY_KEY_REUSED,
  supportBereavementInputSchema,
  supportComplaintInputSchema,
  supportSafetyAcknowledgementSchema,
  supportSafetyAcknowledgementsSchema,
} from '@intafaced/contracts';
import type { SafetyCases } from './safety-cases.js';
import { SupportError } from './support-service.js';
import { mapError } from './router.js';
import { userCopy } from './user-copy.js';

/**
 * `support.safety.*` (BK-safe-03; J-bank-18 #5 and #6): a complaint and a bereavement report, each acknowledged once per
 * request key, and the caller's own acknowledgements. Every door is the signed-in person's own; the case comes off the
 * caller, never from the input.
 */
export function safetyRouter(safety: SafetyCases) {
  return router({
    complain: scopedProcedure('support:write')
      .input(supportComplaintInputSchema)
      .output(supportSafetyAcknowledgementSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await safety.complain(ctx.principal!.userId, input);
        } catch (err) {
          mapSafety(err);
        }
      }),

    reportBereavement: scopedProcedure('support:write')
      .input(supportBereavementInputSchema)
      .output(supportSafetyAcknowledgementSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await safety.reportBereavement(ctx.principal!.userId, input);
        } catch (err) {
          mapSafety(err);
        }
      }),

    mine: scopedProcedure('support:read')
      .output(supportSafetyAcknowledgementsSchema)
      .query(async ({ ctx }) => {
        try {
          return { acknowledgements: await safety.mine(ctx.principal!.userId) };
        } catch (err) {
          mapSafety(err);
        }
      }),
  });
}

const HTTP: Record<string, TRPCError['code']> = {
  [SUPPORT_SAFETY_KEY_REUSED]: 'CONFLICT',
  [SUPPORT_BEREAVEMENT_DATE_INVALID]: 'BAD_REQUEST',
};

/** A safety refusal keeps its code as the cause, so the page reads the code, not a sentence. */
function mapSafety(err: unknown): never {
  if (err instanceof SupportError && HTTP[err.code]) {
    throw new TRPCError({ code: HTTP[err.code]!, message: userCopy(err.code), cause: err });
  }
  return mapError(err);
}
