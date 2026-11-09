/**
 * Live support chat contract (SP-chat-01, J-support-public-05): a customer chats with a person from the site or the app,
 * signed in or as a guest; a closed chat becomes one request holding the transcript.
 *
 * Browser safe: nothing here imports Node.
 *
 * Rules carried by the shapes below:
 * - Who a session belongs to comes from the signed principal, or from a claim svc-support signed for that principal
 *   (`chatIdentityToken`). A page can name an identity only through such a claim; anything else fails and never names the
 *   session's owner. A signed-out visitor is a guest who holds the session's access token.
 * - A message is keyed by (session, `clientMessageId`): the same key sent again stores nothing new and answers the stored
 *   message. Opening is keyed by `clientKey`, closing by the session, so a lost answer is recovered by sending the same
 *   call again, never by a new key.
 * - New messages are read with a cursor (`after`, the last sequence the reader has), every `SUPPORT_CHAT_POLL_MS`.
 * - A closed chat cannot be written to (`support.chat_closed`).
 * - Continuing a chat by email needs a mailbox, which this build does not connect: it answers `vendor.email`.
 */
import { z } from 'zod';

/** How often a chat screen reads new messages. The screen shows it. */
export const SUPPORT_CHAT_POLL_MS = 2_000;
export const SUPPORT_CHAT_MESSAGE_MAX = 2_000;
export const SUPPORT_CHAT_NAME_MAX = 120;
export const SUPPORT_CHAT_EMAIL_MAX = 254;
/** How many messages one read answers at most; a reader with more waiting reads again from the last one. */
export const SUPPORT_CHAT_PAGE_MAX = 200;

export const SUPPORT_CHAT_CLOSED = 'support.chat_closed';
export const SUPPORT_CHAT_NOT_FOUND = 'support.chat_not_found';
export const SUPPORT_CHAT_IDENTITY_INVALID = 'support.chat_identity_invalid';
export const SUPPORT_CHAT_IDENTITY_TTL_UNSET = 'support.chat_identity_ttl_unset';
export const SUPPORT_CHAT_RATE_LIMIT_UNSET = 'support.chat_rate_limit_unset';
export const SUPPORT_CHAT_RATE_LIMITED = 'support.chat_rate_limited';
export const SUPPORT_CHAT_AGENT_UNAVAILABLE = 'support.chat_agent_unavailable';
export const SUPPORT_CHAT_AGENT_NOT_ONLINE = 'support.chat_agent_not_online';
export const SUPPORT_CHAT_ALREADY_ACCEPTED = 'support.chat_already_accepted';
export const SUPPORT_CHAT_NOT_ACCEPTED = 'support.chat_not_accepted';
export const SUPPORT_CHAT_PRECHAT_INVALID = 'support.chat_prechat_invalid';
export const SUPPORT_CHAT_MESSAGE_CONFLICT = 'support.chat_message_conflict';

export const SUPPORT_CHAT_ERROR_CODES = [
  SUPPORT_CHAT_CLOSED,
  SUPPORT_CHAT_NOT_FOUND,
  SUPPORT_CHAT_IDENTITY_INVALID,
  SUPPORT_CHAT_IDENTITY_TTL_UNSET,
  SUPPORT_CHAT_RATE_LIMIT_UNSET,
  SUPPORT_CHAT_RATE_LIMITED,
  SUPPORT_CHAT_AGENT_UNAVAILABLE,
  SUPPORT_CHAT_AGENT_NOT_ONLINE,
  SUPPORT_CHAT_ALREADY_ACCEPTED,
  SUPPORT_CHAT_NOT_ACCEPTED,
  SUPPORT_CHAT_PRECHAT_INVALID,
  SUPPORT_CHAT_MESSAGE_CONFLICT,
] as const;
export type SupportChatErrorCode = (typeof SUPPORT_CHAT_ERROR_CODES)[number];

/** The pre-chat fields the owner may ask for. Blank (none) means a free-text first message only. */
export const SUPPORT_CHAT_PRECHAT_FIELDS = ['name', 'email'] as const;
export const supportChatPrechatFieldSchema = z.enum(SUPPORT_CHAT_PRECHAT_FIELDS);
export type SupportChatPrechatField = z.infer<typeof supportChatPrechatFieldSchema>;

/**
 * Whether a person can answer now: `online` when at least one desk member is online, `busy` when none is online and at
 * least one is busy (a chat opens and waits for an online agent), `offline` when nobody is (the screen offers the request
 * form instead, with the support hours or "not set").
 */
export const supportChatAgentsSchema = z.enum(['online', 'busy', 'offline']);
export type SupportChatAgents = z.infer<typeof supportChatAgentsSchema>;

/** Public: what the chat panel needs before anything is opened. */
export const supportChatAvailabilitySchema = z
  .object({
    agents: supportChatAgentsSchema,
    /** The owner's chat hours as set on the contact channels, or null when not set. */
    hours: z.string().nullable(),
    prechatFields: z.array(supportChatPrechatFieldSchema),
    pollMs: z.number().int().positive(),
  })
  .strict();
export type SupportChatAvailability = z.infer<typeof supportChatAvailabilitySchema>;

const clientKey = z.string().trim().min(8).max(200);
const accessToken = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, 'Expected a chat access token');
const sessionId = z.string().guid();

/** A claim svc-support signed for a signed-in session, for a page that embeds the chat. Short-lived, one account. */
export const supportChatIdentityTokenSchema = z.object({ token: z.string().min(16).max(600), expiresAt: z.string() }).strict();
export type SupportChatIdentityToken = z.infer<typeof supportChatIdentityTokenSchema>;

/**
 * The key a page makes for one chat: a 256-bit capability, as 43 base64url characters. The same key opens the same chat
 * and gives back its access token, so the page keeps it like the token and never puts it in an address.
 */
export const supportChatOpenKeySchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, 'Expected a 256-bit chat key');

export const supportChatOpenInputSchema = z
  .object({
    clientKey: supportChatOpenKeySchema,
    /** A claim from `chatIdentityToken`. Anything else a page sends to name someone fails. */
    identity: z.string().max(600).optional(),
    prechat: z
      .object({
        name: z.string().trim().min(1).max(SUPPORT_CHAT_NAME_MAX).optional(),
        email: z.string().trim().toLowerCase().max(SUPPORT_CHAT_EMAIL_MAX).email().optional(),
      })
      .strict()
      .optional(),
    /** The first message, free text. */
    message: z.string().trim().min(1).max(SUPPORT_CHAT_MESSAGE_MAX),
  })
  .strict();
export type SupportChatOpenInput = z.infer<typeof supportChatOpenInputSchema>;

/** How the session's identity was decided. `refused` means a claim was sent and failed. */
export const supportChatClaimSchema = z.enum(['none', 'verified', 'refused']);
export const supportChatStatusSchema = z.enum(['waiting', 'active', 'closed']);
export type SupportChatStatus = z.infer<typeof supportChatStatusSchema>;
export const supportChatProfileTypeSchema = z.enum(['individual', 'business']);
export type SupportChatProfileType = z.infer<typeof supportChatProfileTypeSchema>;

export const supportChatMessageSchema = z
  .object({
    id: z.string().guid(),
    sessionId,
    seq: z.number().int().positive(),
    author: z.enum(['customer', 'agent']),
    clientMessageId: z.string(),
    body: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type SupportChatMessage = z.infer<typeof supportChatMessageSchema>;

/** One chat session as its customer reads it. */
export const supportChatSessionSchema = z
  .object({
    id: sessionId,
    status: supportChatStatusSchema,
    /** `account` when it belongs to a signed identity, `guest` otherwise. */
    identity: z.enum(['account', 'guest']),
    claim: supportChatClaimSchema,
    /** The claim's refusal code when `claim` is `refused`. */
    claimRefusal: z.string().nullable(),
    /** True while the session waits for an online agent to accept it. */
    waitingForAgent: z.boolean(),
    /** The request the closed chat became, or null while it is open. */
    ticketId: z.string().guid().nullable(),
    createdAt: z.string(),
    closedAt: z.string().nullable(),
  })
  .strict();
export type SupportChatSession = z.infer<typeof supportChatSessionSchema>;

export const supportChatOpenResultSchema = z
  .object({
    session: supportChatSessionSchema,
    /** The way back into the session without a session of ours (a guest, an embedding page). Kept by the page, never in an address. */
    accessToken,
    first: supportChatMessageSchema,
  })
  .strict();
export type SupportChatOpenResult = z.infer<typeof supportChatOpenResultSchema>;

/** A session call from its customer: the signed principal it belongs to, or the session's access token. */
const sessionRef = { sessionId, accessToken: accessToken.optional() };

export const supportChatSendInputSchema = z
  .object({ ...sessionRef, clientMessageId: clientKey, body: z.string().trim().min(1).max(SUPPORT_CHAT_MESSAGE_MAX) })
  .strict();
export type SupportChatSendInput = z.infer<typeof supportChatSendInputSchema>;

export const supportChatPollInputSchema = z.object({ ...sessionRef, after: z.number().int().min(0) }).strict();
export type SupportChatPollInput = z.infer<typeof supportChatPollInputSchema>;

export const supportChatPollSchema = z
  .object({ session: supportChatSessionSchema, messages: z.array(supportChatMessageSchema), pollMs: z.number().int().positive() })
  .strict();
export type SupportChatPoll = z.infer<typeof supportChatPollSchema>;

export const supportChatSessionInputSchema = z.object(sessionRef).strict();
export type SupportChatSessionInput = z.infer<typeof supportChatSessionInputSchema>;

/** Continue by email: needs a mailbox. Without one the answer names `vendor.email` and the chat stays as it was. */
export const supportChatEmailResultSchema = z
  .object({ status: z.literal('not_connected'), code: z.literal('vendor.email'), session: supportChatSessionSchema })
  .strict();
export type SupportChatEmailResult = z.infer<typeof supportChatEmailResultSchema>;

/** The desk's view of one session. */
export const supportChatDeskSessionSchema = supportChatSessionSchema
  .extend({
    userId: z.string().nullable(),
    agentId: z.string().nullable(),
    acceptedAt: z.string().nullable(),
    profileType: supportChatProfileTypeSchema.nullable(),
    /** `read` when identity answered the profile type, `unread` when it could not, `guest` for a guest. */
    profileRead: z.enum(['read', 'unread', 'guest']),
    lastSeq: z.number().int().min(0),
  })
  .strict();
export type SupportChatDeskSession = z.infer<typeof supportChatDeskSessionSchema>;

export const supportChatInboxInputSchema = z.object({ limit: z.number().int().min(1).max(SUPPORT_CHAT_PAGE_MAX) }).strict();
export const supportChatAcceptInputSchema = z.object({ sessionId }).strict();
export const supportChatReplyInputSchema = z
  .object({ sessionId, clientMessageId: clientKey, body: z.string().trim().min(1).max(SUPPORT_CHAT_MESSAGE_MAX) })
  .strict();
export const supportChatDeskPollInputSchema = z.object({ sessionId, after: z.number().int().min(0) }).strict();
export const supportChatDeskPollSchema = z
  .object({ session: supportChatDeskSessionSchema, messages: z.array(supportChatMessageSchema), pollMs: z.number().int().positive() })
  .strict();

/** A pre-chat capture from a guest: an enquiry with source chat. The address is kept sealed and never answered. */
export const supportChatEnquirySchema = z
  .object({
    id: z.string().guid(),
    source: z.literal('chat'),
    sessionId,
    name: z.string().nullable(),
    hasEmail: z.boolean(),
    createdAt: z.string(),
  })
  .strict();
export type SupportChatEnquiry = z.infer<typeof supportChatEnquirySchema>;
export const supportChatEnquiriesInputSchema = z
  .object({ sessionId: sessionId.optional(), limit: z.number().int().min(1).max(SUPPORT_CHAT_PAGE_MAX) })
  .strict();

/** Where a request came from, read by the desk: a chat, with the profile type identity answered when it opened. */
export const supportRequestSourceSchema = z
  .object({
    ticketId: z.string().guid(),
    source: z.literal('chat'),
    sessionId,
    profileType: supportChatProfileTypeSchema.nullable(),
    profileRead: z.enum(['read', 'unread', 'guest']),
    transcript: z.array(supportChatMessageSchema),
  })
  .strict();
export type SupportRequestSource = z.infer<typeof supportRequestSourceSchema>;
export const supportRequestSourceInputSchema = z.object({ ticketId: z.string().guid() }).strict();
