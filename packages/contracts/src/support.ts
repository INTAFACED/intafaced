import { z } from 'zod';
import { accountStateSchema } from './identity.js';

/**
 * Support desk contracts (ops.support Stage-1 ticket spine).
 *
 * Tickets: create / list (mine + ops) / get / comment / status.
 * KB list shape lives here; catalog content may be empty or platform spine.
 * No money: refunds are requests only; never ledger.
 */

export const supportTicketStatusSchema = z.enum(['open', 'pending', 'resolved', 'closed']);
export type SupportTicketStatus = z.infer<typeof supportTicketStatusSchema>;

export const supportTicketCategorySchema = z.enum(['account', 'trading', 'deposit_withdraw', 'phishing', 'other']);
export type SupportTicketCategory = z.infer<typeof supportTicketCategorySchema>;

/**
 * Pasted message headers on a phishing report (I-signin-sessions-27). The same
 * bound as `body`: a schema limit on text, not a product magnitude.
 */
export const SUPPORT_MESSAGE_HEADERS_MAX = 10_000;

export const supportTicketSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  category: supportTicketCategorySchema,
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  /** Pasted headers of a reported message. Null or absent on any other ticket. */
  messageHeaders: z.string().min(1).max(SUPPORT_MESSAGE_HEADERS_MAX).nullable().optional(),
  status: supportTicketStatusSchema,
  assigneeId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SupportTicket = z.infer<typeof supportTicketSchema>;

export const supportCommentSchema = z.object({
  id: z.string().uuid(),
  ticketId: z.string().uuid(),
  authorId: z.string().uuid(),
  /** operator | user — operators use support:ops scope */
  authorRole: z.enum(['user', 'operator']),
  body: z.string().min(1).max(10_000),
  createdAt: z.string().datetime(),
});
export type SupportComment = z.infer<typeof supportCommentSchema>;

export const createTicketInputSchema = z.object({
  category: supportTicketCategorySchema,
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  /** Only for a `phishing` ticket; any other category refuses it. */
  messageHeaders: z.string().min(1).max(SUPPORT_MESSAGE_HEADERS_MAX).optional(),
  /**
   * One key per submission. A replay by the same caller returns the stored
   * ticket and creates no second one. Optional so older callers still parse.
   */
  clientRequestId: z.string().min(1).max(200).optional(),
});
export type CreateTicketInput = z.infer<typeof createTicketInputSchema>;

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
  id: z.string().uuid(),
  ticketId: z.string().uuid(),
  /** 1-based, dense per ticket. A gap means a lost row, not a quiet reorder. */
  sequence: z.number().int().positive(),
  kind: supportTicketEventKindSchema,
  actorId: z.string().uuid(),
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
  ticketId: z.string().uuid(),
  escalatedBy: z.string().uuid(),
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
  ticketId: z.string().uuid(),
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
  ticketId: z.string().uuid(),
  /** Null until an agent sets one. Never guessed. */
  priority: supportTicketPrioritySchema.nullable(),
  ticketType: supportTicketTypeSchema.nullable(),
  labels: z.array(supportLabelSchema).max(SUPPORT_LABELS_MAX),
  updatedAt: z.string().datetime().nullable(),
});
export type SupportTicketProperties = z.infer<typeof supportTicketPropertiesSchema>;

/**
 * Set any of priority, type and labels. An omitted field is left as it is; null
 * clears priority or type; `labels` replaces the whole set. A repeat of the same
 * `clientRequestId` returns the first result.
 */
export const setTicketPropertiesInputSchema = z
  .object({
    ticketId: z.string().uuid(),
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
