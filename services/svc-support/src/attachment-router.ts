import { TRPCError } from '@trpc/server';
import {
  scopedProcedure,
  supportAttachmentLimitsSchema,
  supportAttachmentSettingsSetInputSchema,
  supportAttachmentStatusSchema,
} from '@intafaced/contracts';
import { AttachmentSettingsStaleError, attachmentChangesOf, type AttachmentSettingsBook } from './attachment-settings.js';
import { requireSupportOps, type SupportService } from './support-service.js';
import { userCopy } from './user-copy.js';

/**
 * `attachmentLimits` is the read a signed-in customer or an operator makes: a blank limit is `null` and `missing` names
 * the first piece an attach lacks, so a screen can say what is not set rather than guess. `attachmentStatus` is the
 * operator's view of all five pieces. `setAttachmentSettings` is the operator write: a staff lead on a `support:ops`
 * session, with a reason, from the revision they read. The settings scope `support:admin` does not exist yet; until it
 * lands the lead role is the existing control for desk configuration, as for the contact channels.
 */
export function attachmentProcedures(
  book: AttachmentSettingsBook,
  support: Pick<SupportService, 'listStaff' | 'attachmentLimits' | 'attachmentStatus'>,
) {
  return {
    attachmentLimits: scopedProcedure('support:read')
      .output(supportAttachmentLimitsSchema)
      .query(() => support.attachmentLimits()),

    attachmentStatus: scopedProcedure('support:ops')
      .output(supportAttachmentStatusSchema)
      .query(({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return support.attachmentStatus();
      }),

    setAttachmentSettings: scopedProcedure('support:ops')
      .input(supportAttachmentSettingsSetInputSchema)
      .output(supportAttachmentLimitsSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        const actorId = ctx.principal!.userId;
        const actor = (await support.listStaff()).find((member) => member.userId === actorId);
        if (actor?.role !== 'lead') {
          throw new TRPCError({ code: 'FORBIDDEN', message: userCopy('support.not_lead') });
        }
        try {
          await book.set({
            changes: attachmentChangesOf(input),
            expectedRevision: input.expectedRevision,
            by: actorId,
            reason: input.reason,
            at: new Date().toISOString(),
          });
        } catch (err) {
          if (err instanceof AttachmentSettingsStaleError) {
            throw new TRPCError({ code: 'CONFLICT', message: 'support.attachment_revision_stale', cause: err });
          }
          throw err;
        }
        return support.attachmentLimits();
      }),
  };
}
