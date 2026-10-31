import { z } from 'zod';
import { accountStateSchema } from './identity.js';
import { supportTicketCategorySchema } from './support-categories.js';
import { supportCreateFormSchema } from './support-forms.js';

/**
 * Support desk contracts (ops.support Stage-1 ticket spine).
 *
 * Tickets: create / list (mine + ops) / get / comment / status.
 * KB list shape lives here; catalog content may be empty or platform spine.
 * No money: refunds are requests only; never ledger.
 */

export const supportTicketStatusSchema = z.enum(['open', 'pending', 'on_hold', 'resolved', 'closed']);
export type SupportTicketStatus = z.infer<typeof supportTicketStatusSchema>;

export {
  SUPPORT_CATEGORY_ROUTES,
  SUPPORT_CATEGORY_UNKNOWN,
  SUPPORT_FRAUD_REPORT_KEY_REQUIRED,
  SUPPORT_FRAUD_ROUTE_MISSING,
  SUPPORT_FRAUD_ROUTE_UNSET,
  supportCategoriesSchema,
  supportTicketCategorySchema,
  type SupportCategories,
  type SupportTicketCategory,
} from './support-categories.js';

/**
 * Pasted message headers on a phishing report (I-signin-sessions-27). The same
 * bound as `body`: a schema limit on text, not a product magnitude.
 */
export const SUPPORT_MESSAGE_HEADERS_MAX = 10_000;

/**
 * What the customer reads as their request's status (SP-tickets-01, ENGINE TK-1): `awaiting_reply` when the team's last
 * public reply waits on them, `solved` once resolved or closed, `open` otherwise. It says only whose turn it is, never a
 * time; staff keep reading `status` and the lifecycle facts.
 */
export const SUPPORT_CUSTOMER_STATUSES = ['awaiting_reply', 'open', 'solved'] as const;
export const supportCustomerStatusSchema = z.enum(SUPPORT_CUSTOMER_STATUSES);
export type SupportCustomerStatus = z.infer<typeof supportCustomerStatusSchema>;

export const supportTicketSchema = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  category: supportTicketCategorySchema,
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  /** Pasted headers of a reported message. Null or absent on any other ticket. */
  messageHeaders: z.string().min(1).max(SUPPORT_MESSAGE_HEADERS_MAX).nullable().optional(),
  status: supportTicketStatusSchema,
  assigneeId: z.string().guid().nullable(),
  /** Set when this request was merged into another (SP-tickets-07); the request stays closed and readable. */
  mergedInto: z.string().guid().nullable().optional(),
  /** Set on the owner's own reads (`listMine`, `get`, `createdByRequest`); absent from older services and staff lists. */
  customerStatus: supportCustomerStatusSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SupportTicket = z.infer<typeof supportTicketSchema>;

/** The caller's own request that a `support.create` key made, or null when that key made none (SP-tickets-01 recovery). */
export const supportCreatedByRequestInputSchema = z.object({ clientRequestId: z.string().min(1).max(200) });
export type SupportCreatedByRequestInput = z.infer<typeof supportCreatedByRequestInputSchema>;

export const supportCommentSchema = z.object({
  id: z.string().guid(),
  ticketId: z.string().guid(),
  authorId: z.string().guid(),
  /** operator | user — operators use support:ops scope */
  authorRole: z.enum(['user', 'operator']),
  /**
   * `public` is on the request's thread for the customer; `internal` is a staff-only note (SP-tickets-05), never listed
   * to the customer. Only an operator writes a note.
   */
  visibility: z.enum(['public', 'internal']),
  body: z.string().min(1).max(10_000),
  createdAt: z.string().datetime(),
});
export type SupportComment = z.infer<typeof supportCommentSchema>;

/** The longest internal note, as long as a reply. */
export const SUPPORT_NOTE_MAX = 10_000;

/**
 * A staff-only note on a request (SP-tickets-05). The key is the caller's: the same key again answers the first note and
 * writes nothing. A blank body is refused by svc-support with `support.note_empty`, not by this schema.
 */
export const supportInternalNoteInputSchema = z.object({
  ticketId: z.string().guid(),
  body: z.string().max(SUPPORT_NOTE_MAX),
  clientRequestId: z.string().min(1).max(200),
});
export type SupportInternalNoteInput = z.infer<typeof supportInternalNoteInputSchema>;

export const createTicketInputSchema = z.object({
  category: supportTicketCategorySchema,
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  /**
   * A new request that follows a closed one of the same account (closed stays terminal, so a follow-up is a new,
   * linked request). Any other ticket, or one that is not the caller's and closed, is refused by the service.
   */
  followsTicketId: z.string().guid().optional(),
  /** Only for a `phishing` ticket; any other category refuses it. */
  messageHeaders: z.string().min(1).max(SUPPORT_MESSAGE_HEADERS_MAX).optional(),
  /**
   * One key per submission. A replay by the same caller returns the stored
   * ticket and creates no second one. Optional so older callers still parse.
   */
  clientRequestId: z.string().min(1).max(200).optional(),
  /** The request type's form and its answers (SP-tickets-03). The service checks them against the stored form. */
  form: supportCreateFormSchema.optional(),
});
export type CreateTicketInput = z.infer<typeof createTicketInputSchema>;

/** `support.create` as it arrives: any category text, so the service can refuse an unknown one by name. */
export const createTicketWireInputSchema = createTicketInputSchema.extend({ category: z.string().min(1).max(64) });

/**
 * Who may read a help article (SP-help-centre-02). `public` is everyone, including a signed-out visitor;
 * `signed_in` needs a signed-in account; `staff` is the desk only (a `support:ops` principal).
 */
export const SUPPORT_KB_AUDIENCES = ['public', 'signed_in', 'staff'] as const;
export const supportKbAudienceSchema = z.enum(SUPPORT_KB_AUDIENCES);
export type SupportKbAudience = z.infer<typeof supportKbAudienceSchema>;

/** The reader as the service knows them: from the signed principal, never from a request field. */
export interface SupportKbViewer {
  signedIn: boolean;
  staff: boolean;
}

/** Whether `viewer` may read an article of `audience`. Omitted audience is public (rows written before audiences). */
export function kbAudienceVisibleTo(audience: SupportKbAudience | undefined, viewer: SupportKbViewer): boolean {
  if (audience === undefined || audience === 'public') return true;
  if (audience === 'signed_in') return viewer.signedIn;
  return viewer.staff;
}

/** Bounds of an authored article (SP-kb-01). Wire bounds, not owner caps. */
export const SUPPORT_KB_TITLE_MAX = 200;
export const SUPPORT_KB_BODY_MAX = 20_000;
export const SUPPORT_KB_LIBRARY_ID_MAX = 64;
/** The keys an authored version carries: its text is on the version itself, not in the catalogue. */
export const SUPPORT_KB_STORED_TITLE_KEY = 'support.kb.stored.title';
export const SUPPORT_KB_STORED_BODY_KEY = 'support.kb.stored.body';

export const supportKbArticleSchema = z.object({
  id: z.string().min(1),
  /** i18n catalog key — never raw third-party product names */
  titleKey: z.string().min(1),
  bodyKey: z.string().min(1),
  /**
   * Immutable content version for this `id` (integer ≥ 1). Identity is `id`;
   * a new published body is a new version, not a mutated row.
   */
  version: z.number().int().positive().optional(),
  /** Operator CAS counter on the head row. Same integer as `version` on the wire. */
  revision: z.number().int().positive().optional(),
  /** Public doors return published rows only. Optional so older callers still parse. */
  published: z.boolean().optional(),
  /**
   * Topic on the published version. Optional: a row written before a topic
   * existed omits both. Not a seeded category.
   */
  category: z.string().min(1).max(200).optional(),
  /** Same list bound as escalateTicketInputSchema.citedArticleIds (20), each key-length 200. */
  tags: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** Who may read it. Omitted means public. A reader never receives an article their audience does not allow. */
  audience: supportKbAudienceSchema.optional(),
  /**
   * Text typed in the desk (SP-kb-01). An authored version carries its own title and body as plain text, in `language`;
   * its keys are then the stored-text markers, not catalogue keys. A spine article keyed in the catalogue omits these.
   */
  title: z.string().min(1).max(SUPPORT_KB_TITLE_MAX).optional(),
  body: z.string().min(1).max(SUPPORT_KB_BODY_MAX).optional(),
  language: z.string().min(2).max(32).optional(),
  /** The section this version is filed under. Omitted: in no section (the spine, or a row written before sections). */
  sectionId: z.string().min(1).max(SUPPORT_KB_LIBRARY_ID_MAX).optional(),
});
export type SupportKbArticle = z.infer<typeof supportKbArticleSchema>;

/**
 * Router `searchKb` input — empty/omitted `q` means the published list.
 * `limit` is optional so omit reaches the service named refuse
 * (`support.list_kb_limit_unset`) instead of a Zod "Required". Blank is not 100.
 */
export const searchKbInputSchema = z
  .object({
    q: z.string().max(200).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .optional();
export type SearchKbInput = z.infer<typeof searchKbInputSchema>;

/** Router `getKb` input. Omitted version → latest published. Unknown version is a named refuse, not a silent older body. */
export const getKbArticleInputSchema = z.object({
  id: z.string().min(1).max(200),
  version: z.number().int().positive().optional(),
});
export type GetKbArticleInput = z.infer<typeof getKbArticleInputSchema>;

/** Router `setKbAudience` input (`support:ops`). `baseRevision` is the revision the desk read; a stale one is refused. */
export const setKbAudienceInputSchema = z.object({
  id: z.string().min(1).max(200),
  baseRevision: z.number().int().positive(),
  audience: supportKbAudienceSchema,
});
export type SetKbAudienceInput = z.infer<typeof setKbAudienceInputSchema>;

/** Router `kbAudienceChanges` input (`support:ops`): the article whose audience trail the desk reads. */
export const kbAudienceChangesInputSchema = z.object({ id: z.string().min(1).max(200) }).strict();
export type KbAudienceChangesInput = z.infer<typeof kbAudienceChangesInputSchema>;

/**
 * One audience change of one article (`support.kb_audience_changes`, append-only): the old and the new audience, the
 * revision it moved from and the revision it wrote, who changed it and when. Oldest first on the wire.
 */
export const supportKbAudienceChangeSchema = z
  .object({
    articleId: z.string().min(1),
    fromAudience: supportKbAudienceSchema,
    toAudience: supportKbAudienceSchema,
    fromRevision: z.number().int().positive(),
    toRevision: z.number().int().positive(),
    actorId: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();
export type SupportKbAudienceChange = z.infer<typeof supportKbAudienceChangeSchema>;
export const supportKbAudienceChangeListSchema = z.array(supportKbAudienceChangeSchema);

/**
 * Per-segment visibility (SP-help-centre-02). The number of segments one article may name is a blank owner value
 * (`SUPPORT_KB_SEGMENT_CAP`): blank refuses `support.kb_segment_cap_unset`. With a cap set it still refuses
 * `support.kb_segment_membership_unwired`: who is in a segment is svc-identity's answer, read through a contract that
 * does not exist yet, so the desk never stores a restriction it cannot enforce.
 */
export const SUPPORT_KB_SEGMENT_CAP_UNSET = 'support.kb_segment_cap_unset';
export const SUPPORT_KB_SEGMENT_MEMBERSHIP_UNWIRED = 'support.kb_segment_membership_unwired';
export const SUPPORT_KB_SEGMENT_CAP_KEY = 'SUPPORT_KB_SEGMENT_CAP';

/** Router `setKbSegment` input (`support:ops`): the article and the segment name the desk wants to restrict it to. */
export const setKbSegmentInputSchema = z
  .object({
    id: z.string().min(1).max(200),
    segment: z.string().trim().min(1).max(80),
  })
  .strict();
export type SetKbSegmentInput = z.infer<typeof setKbSegmentInputSchema>;

/**
 * Public get: missing and unpublished are the same answer (`null`).
 * Never throw — svc-support `getKb` is a query that returns null, not an error.
 */
export function publicKbArticleOrNull(article: SupportKbArticle | null | undefined): SupportKbArticle | null {
  if (article == null) return null;
  if (article.published === false) return null;
  return article;
}

/** Public list/search: omit `published: false`. Omitted `published` stays visible (spine back-compat). */
export function publishedKbArticles(articles: readonly SupportKbArticle[]): SupportKbArticle[] {
  return articles.filter((a) => publicKbArticleOrNull(a) !== null);
}

/* ------------------------------------------------------------------ *
 * AUDIT TRAIL — what happened to this ticket, in order, and who did it
 * ------------------------------------------------------------------ */

/**
 * The kinds of thing that happen to a ticket. Every one of them is a fact about
 * the DESK, not about money — there is no `refunded`, no `credited`, no
 * `paid_out`, and there never can be, because this service has no ledger client
 * to make such an event true.
 */
export const supportTicketEventKindSchema = z.enum([
  /** Ticket created by its owner. */
  'opened',
  /** An operator took exclusive ownership (Stage-2 claim). */
  'assigned',
  /** Lifecycle moved. `fromStatus` and `toStatus` are both set. */
  'status_changed',
  /** An operator read the account-state projection while handling this ticket. */
  'grounding_read',
  /** Escalated with a case file. */
  'escalated',
  /** Merged: this request absorbed a duplicate, or was folded into another. Note names the other request. */
  'merged',
]);
export type SupportTicketEventKind = z.infer<typeof supportTicketEventKindSchema>;

/**
 * One row of the audit trail.
 *
 * WHY THIS EXISTS SEPARATELY from `tickets.status`. A status column answers
 * "where is this now"; it cannot answer "who closed it, when, and against
 * what". Before this table, `setStatus` was a bare UPDATE: an operator could
 * resolve a ticket and the only trace was a changed `updated_at`, which the
 * next comment overwrote. A desk whose history is one mutable column is a desk
 * that cannot answer a complaint about itself.
 *
 * `sequence` is dense and per-ticket, so a MISSING row is detectable rather
 * than merely absent — the same reason `agents.agent_actions` carries one.
 */
export const supportTicketEventSchema = z.object({
  id: z.string().guid(),
  ticketId: z.string().guid(),
  /** 1-based, dense per ticket. A gap means a lost row, not a quiet reorder. */
  sequence: z.number().int().positive(),
  kind: supportTicketEventKindSchema,
  actorId: z.string().guid(),
  actorRole: z.enum(['user', 'operator']),
  /** Set only on `status_changed` — otherwise null, never a guessed value. */
  fromStatus: supportTicketStatusSchema.nullable(),
  toStatus: supportTicketStatusSchema.nullable(),
  /**
   * Short operator reason. Bounded at 500 so it stays a reason and does not
   * become a place to paste an account detail the ticket body must not hold.
   */
  note: z.string().max(500).nullable(),
  occurredAt: z.string().datetime(),
});
export type SupportTicketEvent = z.infer<typeof supportTicketEventSchema>;

/* ------------------------------------------------------------------ *
 * GROUNDING + CASE FILE — an answer that can say what it read
 * ------------------------------------------------------------------ */

/** What class of thing was read. Not the thing itself. */
export const supportCitationKindSchema = z.enum(['kb_article', 'account_state', 'ticket_comment']);
export type SupportCitationKind = z.infer<typeof supportCitationKindSchema>;

/**
 * A CITATION: proof that something specific was read, without keeping a copy
 * of it.
 *
 * `ref` names WHAT was read (a KB article id, a user id, a comment id) and
 * `digest` is a sha256 of the content AS IT WAS AT THAT MOMENT. That pair
 * settles the two questions an escalation review actually asks — did the
 * operator read the right article, and has it changed since — while the case
 * file stays free of the content, which is the half that would carry PII.
 *
 * The precedent is `agents.agent_actions`, which stores `inputDigest` /
 * `outputDigest` and not payloads, for exactly this reason: a digest proves
 * what was sent without the table becoming a transcript archive.
 */
export const supportCitationSchema = z.object({
  kind: supportCitationKindSchema,
  /** An id or key. Never content, never a name, never a document. */
  ref: z.string().min(1).max(200),
  /** sha256 hex of the cited content as read. Proof, not a copy. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  readAt: z.string().datetime(),
});
export type SupportCitation = z.infer<typeof supportCitationSchema>;

/**
 * Whether account state was actually read, said out loud.
 *
 * A nullable `accountState` field would have been shorter and would have lied:
 * `null` reads as "nothing notable" when it in fact means "we never looked" or
 * "identity was unreachable". Those are different facts and an escalation
 * review must be able to tell them apart, so they are different variants.
 */
export const supportAccountGroundingSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('read'),
    state: accountStateSchema,
    readAt: z.string().datetime(),
  }),
  z.object({
    status: z.literal('unread'),
    /**
     * `plane_dark` — svc-identity was not configured or not reachable.
     * `not_attempted` — the operator escalated without reading it.
     */
    reason: z.enum(['plane_dark', 'not_attempted']),
  }),
]);
export type SupportAccountGrounding = z.infer<typeof supportAccountGroundingSchema>;

/**
 * Why this left the desk. `money_request` names that a user asked for value to
 * move — it does NOT move it, and this schema deliberately has no `amount`,
 * no `currency` and no `instruction` field for it to move with. The request
 * travels as a named reason to whoever owns the pay/ledger recipe; support
 * files the request and stops there (§0.6).
 */
export const supportEscalationReasonSchema = z.enum(['account_state', 'kyc_review', 'money_request', 'technical', 'other']);
export type SupportEscalationReason = z.infer<typeof supportEscalationReasonSchema>;

/**
 * THE CASE FILE — the context an escalation carries with it.
 *
 * "An escalation that loses its context is a new ticket wearing an old one's
 * number." So the escalation is not a status flip plus a hope that the next
 * operator scrolls up: it is a record of what was read (`citations`), what the
 * account looked like when it was read (`grounding`), and what the escalating
 * operator concluded (`summary`) — written once, immutably, at the moment the
 * decision was made.
 *
 * `citations` has `.min(1)`. An escalation that cites nothing is refused, and
 * that refusal is the entire point of the type.
 */
export const supportCaseFileSchema = z.object({
  ticketId: z.string().guid(),
  escalatedBy: z.string().guid(),
  reason: supportEscalationReasonSchema,
  /** At least one. An ungrounded escalation is refused, not stored empty. */
  citations: z.array(supportCitationSchema).min(1),
  grounding: supportAccountGroundingSchema,
  /** The operator's own words. Bounded; not a place for account details. */
  summary: z.string().min(1).max(2_000),
  createdAt: z.string().datetime(),
});
export type SupportCaseFile = z.infer<typeof supportCaseFileSchema>;

export const escalateTicketInputSchema = z.object({
  ticketId: z.string().guid(),
  reason: supportEscalationReasonSchema,
  summary: z.string().min(1).max(2_000),
  /** KB articles the operator relied on. Ids only — content is never posted back. */
  citedArticleIds: z.array(z.string().min(1).max(200)).max(20).optional(),
});
export type EscalateTicketInput = z.infer<typeof escalateTicketInputSchema>;

/* ------------------------------------------------------------------ *
 * TICKET PROPERTIES — agent-set priority, type and labels (SP-tickets-04)
 *
 * Operator-only. They are deliberately NOT fields of `supportTicketSchema`,
 * which the ticket owner also reads: an internal priority or label must not
 * reach the customer. The queue score stays a ranking, not a promise.
 * ------------------------------------------------------------------ */

/** Who the ticket is waiting on. Null until the first public reply or status change sets one. */
export const supportWaitingOnSchema = z.enum(['team', 'customer']);
export type SupportWaitingOn = z.infer<typeof supportWaitingOnSchema>;

/**
 * Lifecycle facts kept beside the ticket, read by support staff. The owner's own read of their ticket
 * (`supportTicketSchema`) never carries `waitingOn`: it is a desk fact, not a promise to the customer.
 */
export const supportTicketLifecycleSchema = z.object({
  ticketId: z.string().guid(),
  waitingOn: supportWaitingOnSchema.nullable(),
  waitingSince: z.string().datetime().nullable(),
  /** The first public operator reply. Set once; an internal note never sets it. */
  firstPublicReplyAt: z.string().datetime().nullable(),
  /** The closed request this one follows, or null. */
  followsTicketId: z.string().guid().nullable(),
});
export type SupportTicketLifecycle = z.infer<typeof supportTicketLifecycleSchema>;

export const supportTicketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export type SupportTicketPriority = z.infer<typeof supportTicketPrioritySchema>;

export const supportTicketTypeSchema = z.enum(['question', 'problem', 'incident']);
export type SupportTicketType = z.infer<typeof supportTicketTypeSchema>;

/** Input-safety bounds on label text and count, not a product limit. */
export const SUPPORT_LABEL_MAX = 64;
export const SUPPORT_LABELS_MAX = 20;

/** Letters, digits, hyphen and underscore only. A space is `support.label_invalid`. */
export const supportLabelSchema = z
  .string()
  .min(1)
  .max(SUPPORT_LABEL_MAX)
  .regex(/^[A-Za-z0-9_-]+$/);

export const supportTicketPropertiesSchema = z.object({
  ticketId: z.string().guid(),
  /** Null until an agent sets one. Never guessed. */
  priority: supportTicketPrioritySchema.nullable(),
  ticketType: supportTicketTypeSchema.nullable(),
  labels: z.array(supportLabelSchema).max(SUPPORT_LABELS_MAX),
  updatedAt: z.string().datetime().nullable(),
});
export type SupportTicketProperties = z.infer<typeof supportTicketPropertiesSchema>;

/**
 * One field an agent changed on a ticket's properties, read from svc-support's property log (staff only). A save that
 * changed priority and labels is two of these, with the same `logId`, operator, reason and time.
 */
const propertyChangeBase = {
  logId: z.string().regex(/^[0-9]+$/),
  ticketId: z.string().guid(),
  setBy: z.string(),
  reason: z.string().nullable(),
  setAt: z.string().datetime(),
};
export const supportTicketPropertyChangeSchema = z.discriminatedUnion('field', [
  z.object({
    ...propertyChangeBase,
    field: z.literal('priority'),
    from: supportTicketPrioritySchema.nullable(),
    to: supportTicketPrioritySchema.nullable(),
  }),
  z.object({
    ...propertyChangeBase,
    field: z.literal('type'),
    from: supportTicketTypeSchema.nullable(),
    to: supportTicketTypeSchema.nullable(),
  }),
  z.object({
    ...propertyChangeBase,
    field: z.literal('labels'),
    from: z.array(supportLabelSchema).max(SUPPORT_LABELS_MAX),
    to: z.array(supportLabelSchema).max(SUPPORT_LABELS_MAX),
  }),
]);
export type SupportTicketPropertyChange = z.infer<typeof supportTicketPropertyChangeSchema>;

/** Which agent-set properties a customer reads on their own request (SP-tickets-04). The owner chooses; blank refuses. */
export const SUPPORT_CUSTOMER_PROPERTIES = ['priority', 'type'] as const;
export type SupportCustomerProperty = (typeof SUPPORT_CUSTOMER_PROPERTIES)[number];
export const SUPPORT_CUSTOMER_PROPERTIES_UNSET = 'support.customer_properties_unset';

/**
 * The priority and type a customer reads on their own request. `unset` while the owner has not chosen what customers
 * see; a property the owner does not show is null; a shown one not set by the desk yet has a null value.
 */
export const supportMyTicketPropertiesSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unset'), code: z.literal(SUPPORT_CUSTOMER_PROPERTIES_UNSET) }),
  z.object({
    status: z.literal('ok'),
    priority: z.object({ value: supportTicketPrioritySchema.nullable() }).nullable(),
    ticketType: z.object({ value: supportTicketTypeSchema.nullable() }).nullable(),
  }),
]);
export type SupportMyTicketProperties = z.infer<typeof supportMyTicketPropertiesSchema>;

/**
 * Set any of priority, type and labels. An omitted field is left as it is; null
 * clears priority or type; `labels` replaces the whole set. A repeat of the same
 * `clientRequestId` returns the first result.
 */
export const setTicketPropertiesInputSchema = z
  .object({
    ticketId: z.string().guid(),
    priority: supportTicketPrioritySchema.nullable().optional(),
    ticketType: supportTicketTypeSchema.nullable().optional(),
    labels: z.array(supportLabelSchema).max(SUPPORT_LABELS_MAX).optional(),
    /** Short operator reason, kept in the audit log. */
    reason: z.string().min(1).max(500).optional(),
    clientRequestId: z.string().min(1).max(200),
  })
  .refine((v) => v.priority !== undefined || v.ticketType !== undefined || v.labels !== undefined, {
    message: 'set at least one of priority, ticketType or labels',
  });
export type SetTicketPropertiesInput = z.infer<typeof setTicketPropertiesInputSchema>;

/**
 * Saved desk views (SP-desk-01). A view stores a filter, a sort and a layout name.
 * How many personal views one person may keep, and how many shared views the desk may keep, are owner
 * values. Blank stays null and a save refuses `support.view_cap_unset`. Nothing here picks 10 or 100.
 */
export const SUPPORT_VIEW_ERROR_CODES = [
  'support.view_cap_unset',
  'support.view_cap_reached',
  'support.filter_invalid',
  'support.sort_invalid',
  'support.view_not_owner',
  'support.view_revision_stale',
] as const;
export type SupportViewErrorCode = (typeof SUPPORT_VIEW_ERROR_CODES)[number];

export const SUPPORT_VIEW_PERSONAL_CAP_KEY = 'support.view_personal_cap' as const;
export const SUPPORT_VIEW_SHARED_CAP_KEY = 'support.view_shared_cap' as const;

export const SUPPORT_VIEW_SORT_KEYS = ['created', 'updated', 'subject', 'status', 'priority', 'score'] as const;
export const supportViewSortSchema = z
  .object({
    key: z.enum(SUPPORT_VIEW_SORT_KEYS),
    dir: z.enum(['asc', 'desc']),
  })
  .strict();
export type SupportViewSort = z.infer<typeof supportViewSortSchema>;

export const supportViewCapSchema = z
  .object({
    cap: z.number().int().min(0).nullable(),
    missing: z.enum([SUPPORT_VIEW_PERSONAL_CAP_KEY, SUPPORT_VIEW_SHARED_CAP_KEY]).nullable(),
  })
  .strict()
  .refine((v) => (v.cap === null) !== (v.missing === null), {
    message: 'a cap is a number or a missing setting, not both and not neither',
  });
export type SupportViewCap = z.infer<typeof supportViewCapSchema>;

export const supportViewSchema = z
  .object({
    id: z.string().guid(),
    name: z.string().min(1).max(80),
    ownerId: z.string().guid(),
    shared: z.boolean(),
    filter: z.unknown(),
    sort: supportViewSortSchema.nullable(),
    layout: z.string().min(1).max(40).nullable(),
    favourite: z.boolean(),
    revision: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type SupportView = z.infer<typeof supportViewSchema>;

export const supportViewListSchema = z
  .object({
    personalCap: supportViewCapSchema,
    sharedCap: supportViewCapSchema,
    views: z.array(supportViewSchema),
  })
  .strict();
export type SupportViewList = z.infer<typeof supportViewListSchema>;

export const supportViewCountsSchema = z
  .object({
    counts: z.array(
      z
        .object({
          viewId: z.string().guid(),
          count: z.number().int().min(0),
        })
        .strict(),
    ),
  })
  .strict();
export type SupportViewCounts = z.infer<typeof supportViewCountsSchema>;

/** The whole view, so a lost reply replays this payload. `filter` and `sort` stay loose: the service names a bad field. */
export const supportViewSaveInputSchema = z
  .object({
    viewId: z.string().guid().optional(),
    name: z.string().trim().min(1).max(80),
    expectedRevision: z.number().int().min(0),
    shared: z.boolean(),
    filter: z.unknown(),
    sort: z.unknown().nullable().optional(),
    layout: z.unknown().nullable().optional(),
    favourite: z.boolean().optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type SupportViewSaveInput = z.infer<typeof supportViewSaveInputSchema>;

export const supportViewDeleteInputSchema = z
  .object({
    viewId: z.string().guid(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type SupportViewDeleteInput = z.infer<typeof supportViewDeleteInputSchema>;

export interface SupportContract {
  createTicket(input: { userId: string } & CreateTicketInput): Promise<SupportTicket>;
  listMyTickets(input: { userId: string }): Promise<SupportTicket[]>;
  /** Operator desk queue — all tickets, newest first. */
  listAllTickets(): Promise<SupportTicket[]>;
  getTicket(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<SupportTicket>;
  comment(input: { userId: string; ticketId: string; body: string; asOperator?: boolean }): Promise<SupportComment>;
  listComments(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<SupportComment[]>;
  setStatus(input: { operatorId: string; ticketId: string; status: SupportTicketStatus; note?: string }): Promise<SupportTicket>;
  listKb(): Promise<SupportKbArticle[]>;
  /** Search published articles by id/key fragment. Empty query → published list. */
  searchKb(query: string): Promise<SupportKbArticle[]>;
  /**
   * One published article, or null when missing / unpublished.
   * Matches the public `getKb` query without `version`: unknown is null, not a throw.
   * Explicit version is a service/router concern (`getKbArticleInputSchema.version`).
   * Workflow triggers are not part of this contract.
   */
  getKbArticle(id: string): Promise<SupportKbArticle | null>;
  /** Audit trail, oldest first. Owner sees their own; operators see any. */
  listTicketEvents(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<SupportTicketEvent[]>;
  /** Read the ticket owner's account state from svc-identity. Records a `grounding_read`. */
  readAccountState(input: { operatorId: string; ticketId: string }): Promise<SupportAccountGrounding>;
  /** Escalate with a case file. Refuses when nothing was read. Moves no value. */
  escalate(input: { operatorId: string } & EscalateTicketInput): Promise<SupportCaseFile>;
  /** The case file an escalation was made against. null when never escalated. */
  getCaseFile(input: { operatorId: string; ticketId: string }): Promise<SupportCaseFile | null>;
}
