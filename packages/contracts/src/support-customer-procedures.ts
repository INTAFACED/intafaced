import { z } from 'zod';
import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';
import {
  createTicketWireInputSchema,
  getKbArticleInputSchema,
  searchKbInputSchema,
  supportCommentSchema,
  supportCreatedByRequestInputSchema,
  supportKbArticleSchema,
  supportMyTicketPropertiesSchema,
  supportTicketEventSchema,
  supportTicketSchema,
} from './support.js';
import {
  supportAttachmentDownloadSchema,
  supportAttachmentIdInputSchema,
  supportAttachmentLimitsSchema,
  supportAttachmentSchema,
  supportAttachmentTypesDistinct,
} from './support-attachments.js';
import { supportCategoriesSchema } from './support-categories.js';
import { supportRequestFormsSchema } from './support-forms.js';
import { supportExpectedSequenceSchema } from './support-workspace.js';

/**
 * svc-support's doors a signed-in person (and the help centre's public reader) calls, one record per call. The caller
 * is the token's user: no input names an account, and a ticket that is not the caller's answers `support.not_found`.
 * The reads a staff session also makes (`get`, `listComments`, `events`, `ticketAttachments`) are the same doors: the
 * service reads the caller's `support:ops` scope itself. svc-support mounts each from here (`router.ts`).
 */

/** Each refusal by its code, with the status svc-support sends it with (`record-refusal.ts` `supportTrpcError`). */
const STATUS = {
  'support.not_found': 'NOT_FOUND',
  'support.client_request_id_required': 'BAD_REQUEST',
  'support.idempotency_conflict': 'CONFLICT',
  'support.stale_ticket': 'CONFLICT',
  // A request's own words (`create`, `comment`).
  'support.category_unknown': 'BAD_REQUEST',
  'support.category_guided': 'BAD_REQUEST',
  'support.form_unknown': 'BAD_REQUEST',
  'support.field_value_invalid': 'BAD_REQUEST',
  'support.comment_secret_refused': 'BAD_REQUEST',
  'support.headers_not_allowed': 'BAD_REQUEST',
  'support.follow_up_invalid': 'PRECONDITION_FAILED',
  'support.fraud_report_key_required': 'PRECONDITION_FAILED',
  'support.fraud_route_missing': 'PRECONDITION_FAILED',
  'support.fraud_route_unset': 'PRECONDITION_FAILED',
  'support.comment.terminal': 'PRECONDITION_FAILED',
  'support.comment_cap_reached': 'PRECONDITION_FAILED',
  'support.comment_cap_unset': 'PRECONDITION_FAILED',
  'support.macro_placeholder_blank': 'BAD_REQUEST',
  // A page size the owner has not published: blank is not 100.
  'support.list_mine_limit_unset': 'PRECONDITION_FAILED',
  'support.list_comments_limit_unset': 'PRECONDITION_FAILED',
  'support.list_events_limit_unset': 'PRECONDITION_FAILED',
  'support.list_kb_limit_unset': 'PRECONDITION_FAILED',
  'support.list_attachments_limit_unset': 'PRECONDITION_FAILED',
  // The help articles.
  'support.search_query_too_long': 'BAD_REQUEST',
  'support.kb_invalid': 'BAD_REQUEST',
  'support.kb_vendor_name': 'BAD_REQUEST',
  'support.kb_version_unknown': 'PRECONDITION_FAILED',
  'support.kb.not_published': 'PRECONDITION_FAILED',
  'support.feedback_comment_too_long': 'BAD_REQUEST',
  'support.feedback_rate_exceeded': 'TOO_MANY_REQUESTS',
  'support.feedback_rate_limit_unset': 'PRECONDITION_FAILED',
  'support.feedback_request_invalid': 'BAD_REQUEST',
  // Closing and rating one's own request.
  'support.settle.refused': 'PRECONDITION_FAILED',
  'support.transition_same_status': 'PRECONDITION_FAILED',
  'support.transition_illegal': 'PRECONDITION_FAILED',
  'support.already_rated': 'CONFLICT',
  'support.rate_note_too_long': 'BAD_REQUEST',
  'support.rate_score_out_of_range': 'BAD_REQUEST',
  'support.rate_status_refused': 'PRECONDITION_FAILED',
  // Files.
  'support.attachment_body_invalid': 'BAD_REQUEST',
  'support.attachment_type_refused': 'BAD_REQUEST',
  'support.attachment_count_reached': 'PRECONDITION_FAILED',
  'support.attachment_count_unset': 'PRECONDITION_FAILED',
  'support.attachment_scan_refused': 'PRECONDITION_FAILED',
  'support.attachment_scan_unknown': 'PRECONDITION_FAILED',
  'support.attachment_too_large': 'PRECONDITION_FAILED',
  'support.attachments_unconfigured': 'PRECONDITION_FAILED',
} as const satisfies Record<string, RefusalStatus>;
type Code = keyof typeof STATUS;
const refuse = (...codes: Code[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, STATUS[c]])));

const READ = { caller: 'scope', scope: 'support:read' } as const;
const WRITE = { caller: 'scope', scope: 'support:write' } as const;
const PUBLIC = { caller: 'public' } as const;
const base = { service: 'svc-support', module: 'support', transport: 'trpc' } as const;

const TICKET = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT = '22222222-2222-4222-8222-222222222222';
const ticketId = z.string().guid();
/** The caller's own key for one decision: sent again it answers the first result and does nothing twice. */
const clientRequestId = z.string().min(1).max(200);
/** A page size, optional so a missing one reaches the named refusal: there is no default. */
const limit = z.number().int().positive().max(500).optional();
const TICKET_INPUT_SAMPLES = [
  { verdict: 'accept', input: { ticketId: TICKET } },
  { verdict: 'refuse', input: { ticketId: 'not-a-ticket' } },
  { verdict: 'refuse', input: {} },
] as const;

/** A rating as stored: once per ticket, by its owner. */
const supportRatingSchema = z.object({
  ticketId: z.string().guid(),
  userId: z.string().guid(),
  score: z.number().int(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type SupportRating = z.infer<typeof supportRatingSchema>;

/** One vote on one published article version. */
const supportKbFeedbackSchema = z.object({
  articleId: z.string(),
  version: z.number().int().positive(),
  userId: z.string().guid(),
  helpful: z.boolean(),
  /** Present only when this vote opened a request. */
  ticketId: z.string().guid().optional(),
  /** True when this account had already voted on this version; the first vote stands. */
  earlier: z.literal(true).optional(),
});

export const SUPPORT_CATEGORIES = defineProcedure({
  ...base,
  name: 'support.categories',
  kind: 'query',
  path: 'categories',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportCategoriesSchema,
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_CREATE = defineProcedure({
  ...base,
  name: 'support.create',
  kind: 'mutation',
  path: 'create',
  access: WRITE,
  refusals: refuse(
    'support.category_unknown',
    'support.category_guided',
    'support.form_unknown',
    'support.field_value_invalid',
    'support.comment_secret_refused',
    'support.headers_not_allowed',
    'support.follow_up_invalid',
    'support.fraud_report_key_required',
    'support.fraud_route_missing',
    'support.fraud_route_unset',
    'support.idempotency_conflict',
    'support.not_found',
  ),
  input: createTicketWireInputSchema,
  output: supportTicketSchema,
  samples: [
    { verdict: 'accept', input: { category: 'account', subject: 'Locked out', body: 'I cannot sign in.', clientRequestId: 'create:1' } },
    { verdict: 'refuse', input: { category: 'account', subject: '', body: 'I cannot sign in.' } },
    { verdict: 'refuse', input: {} },
  ],
});

export const SUPPORT_LIST_MINE = defineProcedure({
  ...base,
  name: 'support.listMine',
  kind: 'query',
  path: 'listMine',
  access: READ,
  refusals: refuse('support.list_mine_limit_unset'),
  input: z.object({ limit }).optional(),
  output: z.array(supportTicketSchema),
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

export const SUPPORT_CREATED_BY_REQUEST = defineProcedure({
  ...base,
  name: 'support.createdByRequest',
  kind: 'query',
  path: 'createdByRequest',
  access: READ,
  refusals: refuse('support.not_found'),
  input: supportCreatedByRequestInputSchema,
  output: supportTicketSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { clientRequestId: 'create:1' } },
    { verdict: 'refuse', input: { clientRequestId: '' } },
  ],
});

export const SUPPORT_RATED_MINE = defineProcedure({
  ...base,
  name: 'support.ratedMine',
  kind: 'query',
  path: 'ratedMine',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.array(z.string().guid()),
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_GET = defineProcedure({
  ...base,
  name: 'support.get',
  kind: 'query',
  path: 'get',
  access: READ,
  refusals: refuse('support.not_found'),
  input: z.object({ ticketId }),
  output: supportTicketSchema,
  samples: TICKET_INPUT_SAMPLES,
});

export const SUPPORT_COMMENT = defineProcedure({
  ...base,
  name: 'support.comment',
  kind: 'mutation',
  path: 'comment',
  access: WRITE,
  refusals: refuse(
    'support.client_request_id_required',
    'support.comment.terminal',
    'support.comment_cap_reached',
    'support.comment_cap_unset',
    'support.comment_secret_refused',
    'support.idempotency_conflict',
    'support.macro_placeholder_blank',
    'support.not_found',
    'support.stale_ticket',
  ),
  input: z.object({
    ticketId,
    body: z.string().min(1).max(10_000),
    /** Sent again after a lost reply it answers the first comment and writes no second one. */
    clientRequestId: clientRequestId.optional(),
    /** The last trail row (`sequence`) the writer read: a newer row by someone else refuses `support.stale_ticket`. */
    expectedSequence: supportExpectedSequenceSchema.optional(),
  }),
  output: supportCommentSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, body: 'Thanks', clientRequestId: 'reply:1' } },
    { verdict: 'refuse', input: { ticketId: TICKET, body: '' } },
  ],
});

export const SUPPORT_LIST_COMMENTS = defineProcedure({
  ...base,
  name: 'support.listComments',
  kind: 'query',
  path: 'listComments',
  access: READ,
  refusals: refuse('support.list_comments_limit_unset', 'support.not_found'),
  input: z.object({ ticketId, limit }),
  output: z.array(supportCommentSchema),
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, limit: 50 } },
    { verdict: 'refuse', input: { ticketId: TICKET, limit: 501 } },
  ],
});

export const SUPPORT_EVENTS = defineProcedure({
  ...base,
  name: 'support.events',
  kind: 'query',
  path: 'events',
  access: READ,
  refusals: refuse('support.list_events_limit_unset', 'support.not_found'),
  input: z.object({ ticketId, limit }),
  output: z.array(supportTicketEventSchema),
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, limit: 100 } },
    { verdict: 'refuse', input: { limit: 100 } },
  ],
});

export const SUPPORT_SEARCH_KB = defineProcedure({
  ...base,
  name: 'support.searchKb',
  kind: 'query',
  path: 'searchKb',
  access: PUBLIC,
  refusals: refuse('support.list_kb_limit_unset', 'support.search_query_too_long'),
  input: searchKbInputSchema,
  output: z.array(supportKbArticleSchema),
  samples: [
    { verdict: 'accept', input: { q: 'password', limit: 50 } },
    { verdict: 'accept', input: { q: '', limit: 10 } },
    { verdict: 'refuse', input: { q: 'x'.repeat(201), limit: 10 } },
  ],
});

export const SUPPORT_GET_KB = defineProcedure({
  ...base,
  name: 'support.getKb',
  kind: 'query',
  path: 'getKb',
  access: PUBLIC,
  refusals: refuse('support.kb_invalid', 'support.kb_vendor_name', 'support.kb_version_unknown'),
  input: getKbArticleInputSchema,
  output: supportKbArticleSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { id: 'kb.password-reset' } },
    { verdict: 'refuse', input: {} },
  ],
});

export const SUPPORT_CLOSE = defineProcedure({
  ...base,
  name: 'support.close',
  kind: 'mutation',
  path: 'close',
  access: WRITE,
  refusals: refuse(
    'support.client_request_id_required',
    'support.not_found',
    'support.settle.refused',
    'support.transition_same_status',
    'support.transition_illegal',
  ),
  input: z.object({ ticketId, clientRequestId }),
  output: supportTicketSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, clientRequestId: 'close:1' } },
    { verdict: 'refuse', input: { ticketId: TICKET } },
  ],
});

export const SUPPORT_RATE = defineProcedure({
  ...base,
  name: 'support.rate',
  kind: 'mutation',
  path: 'rate',
  access: WRITE,
  refusals: refuse(
    'support.already_rated',
    'support.client_request_id_required',
    'support.not_found',
    'support.rate_note_too_long',
    'support.rate_score_out_of_range',
    'support.rate_status_refused',
  ),
  input: z.object({ ticketId, score: z.number().int(), note: z.string().max(500).optional(), clientRequestId }),
  output: supportRatingSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, score: 5, clientRequestId: 'rate:1' } },
    { verdict: 'refuse', input: { ticketId: TICKET, score: 4.5, clientRequestId: 'rate:1' } },
  ],
});

export const SUPPORT_RATING = defineProcedure({
  ...base,
  name: 'support.rating',
  kind: 'query',
  path: 'rating',
  access: READ,
  refusals: refuse('support.not_found'),
  input: z.object({ ticketId }),
  output: supportRatingSchema.nullable(),
  samples: TICKET_INPUT_SAMPLES,
});

export const SUPPORT_ATTACH = defineProcedure({
  ...base,
  name: 'support.attach',
  kind: 'mutation',
  path: 'attach',
  access: WRITE,
  refusals: refuse(
    'support.attachment_body_invalid',
    'support.attachment_count_reached',
    'support.attachment_count_unset',
    'support.attachment_scan_refused',
    'support.attachment_scan_unknown',
    'support.attachment_too_large',
    'support.attachment_type_refused',
    'support.attachments_unconfigured',
    'support.client_request_id_required',
    'support.not_found',
  ),
  input: z.object({ ticketId, clientRequestId, contentType: z.string().min(1).max(200), bodyBase64: z.string() }),
  output: supportAttachmentSchema,
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, clientRequestId: 'attach:1', contentType: 'image/png', bodyBase64: 'iVBORw0K' } },
    { verdict: 'refuse', input: { ticketId: TICKET, clientRequestId: 'attach:1', contentType: '', bodyBase64: 'iVBORw0K' } },
  ],
});

export const SUPPORT_TICKET_ATTACHMENTS = defineProcedure({
  ...base,
  name: 'support.ticketAttachments',
  kind: 'query',
  path: 'ticketAttachments',
  access: READ,
  refusals: refuse('support.list_attachments_limit_unset', 'support.not_found'),
  input: z.object({ ticketId, limit }),
  output: z.array(supportAttachmentSchema),
  samples: [
    { verdict: 'accept', input: { ticketId: TICKET, limit: 20 } },
    { verdict: 'refuse', input: { ticketId: 'x', limit: 20 } },
  ],
});

export const SUPPORT_ATTACHMENT_DOWNLOAD = defineProcedure({
  ...base,
  name: 'support.attachmentDownload',
  kind: 'query',
  path: 'attachmentDownload',
  access: READ,
  refusals: refuse(
    'support.attachment_scan_refused',
    'support.attachment_scan_unknown',
    'support.attachments_unconfigured',
    'support.not_found',
  ),
  input: supportAttachmentIdInputSchema,
  output: supportAttachmentDownloadSchema,
  samples: [
    { verdict: 'accept', input: { attachmentId: ATTACHMENT } },
    { verdict: 'refuse', input: { attachmentId: 'x' } },
  ],
});

export const SUPPORT_ATTACHMENT_LIMITS = defineProcedure({
  ...base,
  name: 'support.attachmentLimits',
  kind: 'query',
  path: 'attachmentLimits',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportAttachmentLimitsSchema,
  accept: { typesUnique: { says: 'no media type is listed twice in allowedTypes', holds: supportAttachmentTypesDistinct } },
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_KB_FEEDBACK = defineProcedure({
  ...base,
  name: 'support.kbFeedback',
  kind: 'mutation',
  path: 'kbFeedback',
  access: WRITE,
  refusals: refuse(
    'support.client_request_id_required',
    'support.feedback_comment_too_long',
    'support.feedback_rate_exceeded',
    'support.feedback_rate_limit_unset',
    'support.feedback_request_invalid',
    'support.kb.not_published',
  ),
  input: z.object({
    id: z.string().min(1).max(200),
    helpful: z.boolean(),
    clientRequestId,
    /** Kept on an unhelpful vote. A request needs this and helpful false. */
    comment: z.string().max(2_000).optional(),
    /** Opens one linked request. Refused unless the vote is unhelpful and the comment is set. */
    openRequest: z.boolean().optional(),
  }),
  output: supportKbFeedbackSchema,
  samples: [
    { verdict: 'accept', input: { id: 'kb.password-reset', helpful: true, clientRequestId: 'vote:1' } },
    { verdict: 'refuse', input: { id: 'kb.password-reset', clientRequestId: 'vote:1' } },
  ],
});

export const SUPPORT_KB_RELATED = defineProcedure({
  ...base,
  name: 'support.kbRelated',
  kind: 'query',
  path: 'kbRelated',
  access: PUBLIC,
  refusals: refuse(),
  input: z.object({ id: z.string().min(1).max(200) }),
  output: z.array(supportKbArticleSchema),
  samples: [
    { verdict: 'accept', input: { id: 'kb.password-reset' } },
    { verdict: 'refuse', input: { id: '' } },
  ],
});

export const SUPPORT_MY_TICKET_PROPERTIES = defineProcedure({
  ...base,
  name: 'support.myTicketProperties',
  kind: 'query',
  path: 'myTicketProperties',
  access: READ,
  refusals: refuse('support.not_found'),
  input: z.object({ ticketId }),
  output: supportMyTicketPropertiesSchema,
  samples: TICKET_INPUT_SAMPLES,
});

export const SUPPORT_REQUEST_FORMS = defineProcedure({
  ...base,
  name: 'support.requestForms',
  kind: 'query',
  path: 'requestForms',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: supportRequestFormsSchema,
  samples: [{ verdict: 'accept' }],
});

/** Every svc-support record a person's own session or the public help centre calls. */
export const SUPPORT_CUSTOMER_PROCEDURES = [
  SUPPORT_CATEGORIES,
  SUPPORT_CREATE,
  SUPPORT_LIST_MINE,
  SUPPORT_CREATED_BY_REQUEST,
  SUPPORT_RATED_MINE,
  SUPPORT_GET,
  SUPPORT_COMMENT,
  SUPPORT_LIST_COMMENTS,
  SUPPORT_EVENTS,
  SUPPORT_SEARCH_KB,
  SUPPORT_GET_KB,
  SUPPORT_CLOSE,
  SUPPORT_RATE,
  SUPPORT_RATING,
  SUPPORT_ATTACH,
  SUPPORT_TICKET_ATTACHMENTS,
  SUPPORT_ATTACHMENT_DOWNLOAD,
  SUPPORT_ATTACHMENT_LIMITS,
  SUPPORT_KB_FEEDBACK,
  SUPPORT_KB_RELATED,
  SUPPORT_MY_TICKET_PROPERTIES,
  SUPPORT_REQUEST_FORMS,
] as const;
