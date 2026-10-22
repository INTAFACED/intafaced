import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, scopedProcedure, supportHoursSchema, supportHoursSetInputSchema } from '@intafaced/contracts';
import { SupportHoursError } from './support-hours.js';
import { requireSupportOps, SupportError, type SupportService } from './support-service.js';
import { userCopy } from './user-copy.js';

/**
 * Business hours (SP-sla-02). `hours` is the public read: blank until the owner sets it, never an error. `hoursNow`
 * says whether the desk is open now and refuses `support.hours_unset` while the hours are blank, so nobody is told
 * "open" or "closed" from hours nobody set. `setHours` is the operator write: a staff lead on a `support:ops`
 * session, with a reason, from the revision the operator read. The settings scope `support:admin` does not exist
 * yet; until it lands the lead role is the existing control for desk configuration, as for contact channels.
 */
export function hoursProcedures(support: Pick<SupportService, 'getHours' | 'hoursNow' | 'setHours'>) {
  const refuse = (err: unknown): never => {
    if (err instanceof SupportHoursError) {
      const code =
        err.code === 'support.hours_unset'
          ? 'PRECONDITION_FAILED'
          : err.code === 'support.hours_revision_stale'
            ? 'CONFLICT'
            : 'BAD_REQUEST';
      throw new TRPCError({ code, message: err.code, cause: err });
    }
    if (err instanceof SupportError && err.code === 'support.not_lead') {
      throw new TRPCError({ code: 'FORBIDDEN', message: userCopy('support.not_lead'), cause: err });
    }
    throw err;
  };
  return {
    hours: publicProcedure.output(supportHoursSchema).query(() => support.getHours()),

    hoursNow: publicProcedure.output(z.object({ open: z.boolean(), at: z.string().datetime() })).query(async () => {
      try {
        return await support.hoursNow();
      } catch (err) {
        return refuse(err);
      }
    }),

    setHours: scopedProcedure('support:ops')
      .input(supportHoursSetInputSchema)
      .output(supportHoursSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        try {
          return await support.setHours({ actorId: ctx.principal!.userId, ...input });
        } catch (err) {
          return refuse(err);
        }
      }),
  };
}
