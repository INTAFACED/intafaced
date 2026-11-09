import { z } from 'zod';
import { scopedProcedure } from '@intafaced/contracts';
import { TICKET_LINK_KINDS, type TicketLinks } from './ticket-links.js';
import { requireSupportOps } from './support-service.js';
import { mapError } from './router.js';

const linkSchema = z.object({
  ticketId: z.string(),
  kind: z.enum(TICKET_LINK_KINDS),
  recordId: z.string(),
  recoveryRequired: z.boolean(),
  linkedBy: z.string(),
  linkedAt: z.string(),
});

/**
 * Links from a request to the customer's own records (J-support-public-20 #1). The desk's (`support:ops`) only, by
 * ticket: the customer comes off the ticket, and the owning service decides whether the record is theirs.
 */
export function ticketLinkProcedures(links: TicketLinks) {
  return {
    linkRecord: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid(), kind: z.enum(TICKET_LINK_KINDS), recordId: z.string().min(1).max(64) }).strict())
      .output(linkSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await links.link(ctx.principal!.userId, input);
        } catch (err) {
          mapError(err);
        }
      }),
    ticketLinks: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid() }).strict())
      .output(z.array(linkSchema))
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await links.list(ctx.principal!.userId, input.ticketId);
        } catch (err) {
          mapError(err);
        }
      }),
  };
}
