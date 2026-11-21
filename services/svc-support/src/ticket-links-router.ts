import { z } from 'zod';
import { scopedProcedure } from '@intafaced/contracts';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  SUPPORT_DESK_TICKET_LINKS,
  SUPPORT_TICKET_LINK_KINDS,
  supportTicketLinkSchema,
} from '@intafaced/contracts/support-desk-procedures';
import type { TicketLinks } from './ticket-links.js';
import { requireSupportOps } from './support-service.js';
import { supportRefusal } from './record-refusal.js';

/**
 * Links from a request to the customer's own records (J-support-public-20 #1). The desk's (`support:ops`) only, by
 * ticket: the customer comes off the ticket, and the owning service decides whether the record is theirs.
 */
export function ticketLinkProcedures(links: TicketLinks, mapError: (err: unknown) => never) {
  return {
    linkRecord: scopedProcedure('support:ops')
      .input(
        z.object({ ticketId: z.string().guid(), kind: z.enum(SUPPORT_TICKET_LINK_KINDS), recordId: z.string().min(1).max(64) }).strict(),
      )
      .output(supportTicketLinkSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await links.link(ctx.principal!.userId, input);
        } catch (err) {
          mapError(err);
        }
      }),
    ticketLinks: mountRecord(
      SUPPORT_DESK_TICKET_LINKS,
      ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        return links.list(ctx.principal.userId, input.ticketId);
      },
      supportRefusal,
    ),
  };
}
