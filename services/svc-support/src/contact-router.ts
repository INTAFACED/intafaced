import { TRPCError } from '@trpc/server';
import { publicProcedure, scopedProcedure, supportContactChannelsSchema, supportContactSetInputSchema } from '@intafaced/contracts';
import { ContactStaleError, contactChangesOf, type ContactBook } from './contact-channels.js';
import { requireSupportOps, type SupportService } from './support-service.js';
import { userCopy } from './user-copy.js';

/**
 * `contactChannels` is the public read: the help centre shows it to a signed-out visitor, and a blank channel is `null`, not
 * an error. `setContactChannels` is the operator write: a staff lead on a `support:ops` session, with a reason, from the
 * revision the operator read. The settings scope `support:admin` does not exist yet; until it lands the lead role is the
 * existing control for desk configuration (groups and appointments use it too).
 */
export function contactProcedures(book: ContactBook, support: Pick<SupportService, 'listStaff'>) {
  return {
    contactChannels: publicProcedure.output(supportContactChannelsSchema).query(() => book.get()),

    setContactChannels: scopedProcedure('support:ops')
      .input(supportContactSetInputSchema)
      .output(supportContactChannelsSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        const actorId = ctx.principal!.userId;
        const actor = (await support.listStaff()).find((member) => member.userId === actorId);
        if (actor?.role !== 'lead') {
          throw new TRPCError({ code: 'FORBIDDEN', message: userCopy('support.not_lead') });
        }
        try {
          return await book.set({
            changes: contactChangesOf(input),
            expectedRevision: input.expectedRevision,
            by: actorId,
            reason: input.reason,
            at: new Date().toISOString(),
          });
        } catch (err) {
          if (err instanceof ContactStaleError) {
            throw new TRPCError({ code: 'CONFLICT', message: 'support.contact_revision_stale', cause: err });
          }
          throw err;
        }
      }),
  };
}
