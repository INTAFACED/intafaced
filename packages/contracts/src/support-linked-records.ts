import { z } from 'zod';

/**
 * Records linked to a support request (J-support-public-20 #1): the desk links a related order, withdrawal or deposit to a
 * ticket by its id, and only a record that already belongs to the ticket's customer can be linked.
 *
 * Browser-safe: zod only, so the admin console can import it through `@intafaced/contracts/support-linked-records`.
 *
 * WHO DECIDES OWNERSHIP. svc-support never reads another service's tables. The customer comes off the ticket, never from
 * the operator's input, and the service that owns the record answers whether it is that customer's: svc-pay for a
 * withdrawal or a deposit (`SUPPORT_RECORD_OWNERSHIP_PATH`, `support-record-ownership.ts`), svc-trade for an order. A missing
 * id, another customer's id and an id of another kind all refuse with the same `support.link_record_not_owned`, so the
 * desk cannot learn whether an id exists or whose it is. An owner that is not configured, or does not answer, refuses with
 * its own code naming that service: it is never read as "not owned", and never as "owned".
 *
 * A link carries the record's kind and id only: no amount, status, asset or address is copied onto the ticket.
 */

/** The record kinds the desk can link. */
export const SUPPORT_LINKABLE_RECORD_KINDS = ['order', 'withdrawal', 'deposit'] as const;
export type SupportLinkableRecordKind = (typeof SUPPORT_LINKABLE_RECORD_KINDS)[number];

/** The service that answers whether a record of each kind is the customer's. */
export const SUPPORT_LINKED_RECORD_OWNER: Readonly<Record<SupportLinkableRecordKind, 'svc-trade' | 'svc-pay'>> = {
  order: 'svc-trade',
  withdrawal: 'svc-pay',
  deposit: 'svc-pay',
};

/**
 * Typed refusals.
 * `support.link_record_not_owned`: the owning service answered, and the record is not this ticket's customer's (or does not
 * exist, or is of another kind). Nothing is linked.
 * `support.link_record_owner_unwired`: this deployment has no address or credential for the owning service. Nothing is linked.
 * `support.link_record_owner_unreachable`: the owning service did not give a verified answer (down, no such door, or an
 * answer that is not the contract's). Nothing is linked; trying again later may work.
 */
export const SUPPORT_LINK_RECORD_ERROR_CODES = [
  'support.link_record_not_owned',
  'support.link_record_owner_unwired',
  'support.link_record_owner_unreachable',
] as const;
export type SupportLinkRecordErrorCode = (typeof SUPPORT_LINK_RECORD_ERROR_CODES)[number];

export const supportLinkRecordInputSchema = z
  .object({
    ticketId: z.string().guid(),
    kind: z.enum(SUPPORT_LINKABLE_RECORD_KINDS),
    /** The owning service's own record id. */
    recordId: z.string().guid(),
  })
  .strict();
export type SupportLinkRecordInput = z.infer<typeof supportLinkRecordInputSchema>;

export const supportLinkedRecordSchema = z
  .object({
    ticketId: z.string().guid(),
    kind: z.enum(SUPPORT_LINKABLE_RECORD_KINDS),
    recordId: z.string().guid(),
    /** The operator who linked it. */
    linkedBy: z.string().min(1),
    linkedAt: z.string().datetime(),
  })
  .strict();
export type SupportLinkedRecord = z.infer<typeof supportLinkedRecordSchema>;

export const supportLinkedRecordsInputSchema = z.object({ ticketId: z.string().guid() }).strict();

/** The records linked to one request, oldest first. */
export const supportLinkedRecordListSchema = z.object({ records: z.array(supportLinkedRecordSchema) }).strict();
export type SupportLinkedRecordList = z.infer<typeof supportLinkedRecordListSchema>;
