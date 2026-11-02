import { TRPCError } from '@trpc/server';
import {
  SUPPORT_LINK_RECORD_ERROR_CODES,
  scopedProcedure,
  supportLinkedRecordListSchema,
  supportLinkedRecordSchema,
  supportLinkedRecordsInputSchema,
  supportLinkRecordInputSchema,
} from '@intafaced/contracts';
import type { LinkedRecords } from './linked-records.js';
import { requireSupportOps, SupportError } from './support-service.js';
import { mapError } from './router.js';
import { userCopy } from './user-copy.js';

/**
 * Records linked to a request (J-support-public-20 #1). Both procedures are the desk's (`support:ops`) and take a ticket,
 * never a customer: the customer comes off the ticket, and a ticket outside the caller's desk scope answers as not found.
 */
export function linkedRecordProcedures(links: LinkedRecords) {
  return {
    /** Link an order, withdrawal or deposit the owning service says is the ticket customer's. Refused, nothing is linked. */
    linkRecord: scopedProcedure('support:ops')
      .input(supportLinkRecordInputSchema)
      .output(supportLinkedRecordSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return await links.link(ctx.principal!.userId, input);
        } catch (err) {
          mapLink(err);
        }
      }),

    /** The records linked to one request, oldest first. */
    linkedRecords: scopedProcedure('support:ops')
      .input(supportLinkedRecordsInputSchema)
      .output(supportLinkedRecordListSchema)
      .query(async ({ ctx, input }) => {
        try {
          requireSupportOps(ctx.principal!);
          return { records: await links.list(ctx.principal!.userId, input.ticketId) };
        } catch (err) {
          mapLink(err);
        }
      }),
  };
}

const HTTP: Record<(typeof SUPPORT_LINK_RECORD_ERROR_CODES)[number], TRPCError['code']> = {
  'support.link_record_not_owned': 'BAD_REQUEST',
  'support.link_record_owner_unwired': 'PRECONDITION_FAILED',
  'support.link_record_owner_unreachable': 'PRECONDITION_FAILED',
};

/** A link refusal keeps its code in the message, and names the owning service when one is the blocker. */
function mapLink(err: unknown): never {
  if (err instanceof SupportError && err.code in HTTP) {
    const message = err.missingKey ? `${userCopy(err.code)} ${err.missingKey}` : userCopy(err.code);
    throw new TRPCError({ code: HTTP[err.code as keyof typeof HTTP], message, cause: err });
  }
  return mapError(err);
}
