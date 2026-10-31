/**
 * Guest support requests (SP-tickets-01, J-support-public-03): a person with no account asks for help by email.
 *
 * Browser safe: zod only.
 *
 * 1. `support.guestCreate` (public) stores a guest request and asks svc-notify to mail a verification link. No ticket is
 *    opened yet. With no mail sender the request stays pending and the call refuses `vendor.email`.
 * 2. `support.guestVerify` (public) takes the token from that link and opens the ticket, once: the same link used again
 *    opens the same ticket. It answers with an access token for that one request.
 * 3. `support.guestThread` and `support.guestReply` (public) read and reply on that one request with the access token. The
 *    access token is never a session: it names one request, it is checked only by these two calls, and no other call
 *    accepts it.
 *
 * Every limit is an owner value: the link lifetime, the per-address rate and its window, and how long a guest's address
 * is kept. A blank one refuses by name and stores nothing.
 */
import { z } from 'zod';
import { supportCommentSchema, supportTicketSchema } from './support.js';

/** Codes this path answers with, beside `vendor.email` (no sender) and `support.category_unknown`. */
export const SUPPORT_GUEST_RATE_LIMIT_UNSET = 'support.guest_rate_limit_unset';
export const SUPPORT_GUEST_RATE_LIMITED = 'support.guest_rate_limited';
export const SUPPORT_GUEST_LINK_TTL_UNSET = 'support.guest_link_ttl_unset';
export const SUPPORT_GUEST_LINK_EXPIRED = 'support.guest_link_expired';
export const SUPPORT_GUEST_RETENTION_UNSET = 'support.guest_retention_unset';
/** No key to seal a guest's address with: nothing is stored. */
export const SUPPORT_GUEST_ADDRESS_KEY_UNSET = 'support.guest_address_key_unset';
/** A token that names no request, or was altered. Reads the same as one that never existed. */
export const SUPPORT_GUEST_LINK_INVALID = 'support.guest_link_invalid';
/** The mail sender took the request but did not say whether it sent it: never sent again under that key. */
export const SUPPORT_GUEST_DELIVERY_UNKNOWN = 'support.guest_delivery_unknown';

/** A one-time token: `<id>.<secret>`, both base64url. Only a hash of the secret is stored. */
export const supportGuestTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{32,128}$/);

export const supportGuestCreateInputSchema = z
  .object({
    email: z.string().trim().email().max(320),
    /** Any category text, so an unknown one is refused by name. */
    category: z.string().min(1).max(64),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(10_000),
    /** One key per submission: a replay answers the first submission and mails nothing new. */
    clientRequestId: z.string().min(1).max(200),
  })
  .strict();
export type SupportGuestCreateInput = z.infer<typeof supportGuestCreateInputSchema>;

/** `check_email`: the link was handed to the sender. No ticket exists until it is used. */
export const supportGuestCreateResultSchema = z
  .object({
    guestRequestId: z.string().guid(),
    state: z.literal('check_email'),
    linkExpiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type SupportGuestCreateResult = z.infer<typeof supportGuestCreateResultSchema>;

export const supportGuestVerifyInputSchema = z.object({ token: supportGuestTokenSchema }).strict();
export type SupportGuestVerifyInput = z.infer<typeof supportGuestVerifyInputSchema>;

export const supportGuestVerifyResultSchema = z
  .object({
    ticketId: z.string().guid(),
    /** Reads and replies on this one request only. Never a session. */
    access: supportGuestTokenSchema,
    accessExpiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type SupportGuestVerifyResult = z.infer<typeof supportGuestVerifyResultSchema>;

/** `limit` is the page of comments, as `support.listComments` takes it: the caller says how many. */
export const supportGuestThreadInputSchema = z
  .object({ access: supportGuestTokenSchema, limit: z.number().int().positive().max(500) })
  .strict();
export type SupportGuestThreadInput = z.infer<typeof supportGuestThreadInputSchema>;

export const supportGuestThreadSchema = z
  .object({
    ticket: supportTicketSchema,
    /** The public thread only: staff-only notes are never here. */
    comments: z.array(supportCommentSchema),
  })
  .strict();
export type SupportGuestThread = z.infer<typeof supportGuestThreadSchema>;

export const supportGuestReplyInputSchema = z
  .object({
    access: supportGuestTokenSchema,
    body: z.string().min(1).max(10_000),
    clientRequestId: z.string().min(1).max(200),
  })
  .strict();
export type SupportGuestReplyInput = z.infer<typeof supportGuestReplyInputSchema>;

/** The customer-app paths the links open. */
export const SUPPORT_GUEST_VERIFY_PATH = '/support/guest/verify';
export const SUPPORT_GUEST_REQUEST_PATH = '/support/guest/request';
