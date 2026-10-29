import { boolean, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk } from '@intafaced/db';

/**
 * svc-support schema — tickets, comments, audit trail, case files, published KB.
 *
 * Doctrine §2: this schema is the only one this service may touch.
 * No balances, no money columns, no cross-service table reads.
 *
 * Account state is NOT a table here and must never become one. It is read per
 * request from svc-identity (`src/account-state.ts`); a `support.accounts`
 * projection would be a second source of truth for whether an account is
 * frozen, and an operator reassuring a user from a stale copy is the failure it
 * would cause.
 */

export const schema = pgSchema('support');

export const tickets = schema.table('tickets', {
  id: pk(),
  userId: text('user_id').notNull(),
  category: text('category').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  messageHeaders: text('message_headers'),
  status: text('status').$type<'open' | 'pending' | 'resolved' | 'closed'>().notNull().default('open'),
  assigneeId: text('assignee_id'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const comments = schema.table('comments', {
  id: pk(),
  ticketId: uuid('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull(),
  authorRole: text('author_role').$type<'user' | 'operator'>().notNull(),
  /** `internal` is a staff-only note (SP-tickets-05); a customer read never returns it. */
  visibility: text('visibility').$type<'public' | 'internal'>().notNull().default('public'),
  body: text('body').notNull(),
  createdAt: createdAt(),
});

/**
 * The audit trail. Append-only — the trigger is in migration 0001, and 0005
 * refuses every update and row removal even after the ticket row is gone.
 * The foreign key does not cascade: ticket removal must not erase the trail.
 */
export const ticketEvents = schema.table(
  'ticket_events',
  {
    id: pk(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'restrict' }),
    /** 1-based, dense per ticket. The gap is the evidence a row was lost. */
    sequence: integer('sequence').notNull(),
    kind: text('kind').$type<'opened' | 'assigned' | 'status_changed' | 'grounding_read' | 'escalated' | 'merged'>().notNull(),
    actorId: text('actor_id').notNull(),
    actorRole: text('actor_role').$type<'user' | 'operator'>().notNull(),
    fromStatus: text('from_status').$type<'open' | 'pending' | 'resolved' | 'closed'>(),
    toStatus: text('to_status').$type<'open' | 'pending' | 'resolved' | 'closed'>(),
    note: text('note'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    /** Dense per ticket, and the anti-loss constraint — not a lookup aid. */
    uniqueIndex('ticket_events_ticket_sequence_idx').on(t.ticketId, t.sequence),
    index('ticket_events_ticket_occurred_idx').on(t.ticketId, t.occurredAt),
  ],
);

/**
 * A duplicate request folded into another (SP-tickets-07). One row per source: the merged-into link and the stored result a
 * replay of (source, survivor) returns. Rows are never removed with a ticket (no cascade).
 */
export const ticketMerges = schema.table('ticket_merges', {
  sourceId: uuid('source_id')
    .primaryKey()
    .references(() => tickets.id, { onDelete: 'restrict' }),
  survivorId: uuid('survivor_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'restrict' }),
  actorId: text('actor_id').notNull(),
  reason: text('reason').notNull(),
  commentsMoved: integer('comments_moved').notNull(),
  attachmentsMoved: integer('attachments_moved').notNull(),
  mergedAt: timestamp('merged_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/**
 * The context an escalation carries. Immutable once written (trigger, 0001;
 * 0005 refuses row removal even when the ticket row is gone). The foreign
 * key does not cascade. A mutable case file can be brought into line with
 * the outcome afterwards, which is the failure this table exists to prevent.
 *
 * NO AMOUNT COLUMN, deliberately. `reason` may be `money_request` — support
 * files the request and the pay/ledger recipe moves the value (§0.6).
 */
export const caseFiles = schema.table('case_files', {
  id: pk(),
  ticketId: uuid('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'restrict' }),
  escalatedBy: text('escalated_by').notNull(),
  reason: text('reason').$type<'account_state' | 'kyc_review' | 'money_request' | 'technical' | 'other'>().notNull(),
  /** `{kind, ref, digest, readAt}[]` — proof of what was read, never a copy. */
  citations: jsonb('citations').notNull(),
  /** Account projection as read, or an explicit "never read, here is why". */
  grounding: jsonb('grounding').notNull(),
  summary: text('summary').notNull(),
  createdAt: createdAt(),
});

/**
 * Versioned published help articles. Keys only — never body text, never money.
 *
 * `revision` is the citation-stable content version (title/body *keys*).
 * Locale copy lives in `@intafaced/i18n` and must not bump this number.
 */
export const kbArticles = schema.table('kb_articles', {
  id: text('id').primaryKey(),
  titleKey: text('title_key').notNull(),
  bodyKey: text('body_key').notNull(),
  revision: integer('revision').notNull(),
  published: boolean('published').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type TicketRow = typeof tickets.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type TicketEventRow = typeof ticketEvents.$inferSelect;
export type CaseFileRow = typeof caseFiles.$inferSelect;
export type KbArticleRow = typeof kbArticles.$inferSelect;

/**
 * Immutable published bodies. `id` is identity; `version` is the generation.
 * Locale copy must not insert a row.
 */
export const kbArticleVersions = schema.table(
  'kb_article_versions',
  {
    id: text('id').notNull(),
    version: integer('version').notNull(),
    titleKey: text('title_key').notNull(),
    bodyKey: text('body_key').notNull(),
    /** Topic of this generation. Null until a publish supplies one. */
    category: text('category'),
    tags: jsonb('tags').$type<string[] | null>(),
    /** Who may read this generation: public, signed_in or staff. */
    audience: text('audience').notNull().default('public'),
    /** Text typed in the desk (0032). All three null for a catalogue-keyed version. */
    title: text('title'),
    body: text('body'),
    language: text('language'),
    /** The section this generation is filed under (0032). */
    sectionId: text('section_id'),
  },
  (t) => [primaryKey({ columns: [t.id, t.version] })],
);
export type KbArticleVersionRow = typeof kbArticleVersions.$inferSelect;

/** Help library categories (0032). Created by support staff, never seeded; retired, never deleted. */
export const kbCategories = schema.table('kb_categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  retired: boolean('retired').notNull().default(false),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/** Sections under a category (0032). */
export const kbSections = schema.table('kb_sections', {
  id: text('id').primaryKey(),
  categoryId: text('category_id').notNull(),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  retired: boolean('retired').notNull().default(false),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

/** First result of an owner write, keyed by procedure + actor + client request. */
export const writeReceipts = schema.table(
  'write_receipts',
  {
    procedure: text('procedure').notNull(),
    actorId: text('actor_id').notNull(),
    clientRequestId: text('client_request_id').notNull(),
    result: jsonb('result').notNull(),
  },
  (t) => [primaryKey({ columns: [t.procedure, t.actorId, t.clientRequestId] })],
);

/** One rating per ticket. Score range is the table check (1..5). */
export const ticketRatings = schema.table('ticket_ratings', {
  id: pk(),
  ticketId: uuid('ticket_id')
    .notNull()
    .unique()
    .references(() => tickets.id, { onDelete: 'restrict' }),
  userId: text('user_id').notNull(),
  score: integer('score').notNull(),
  note: text('note'),
  clientRequestId: text('client_request_id').notNull(),
  createdAt: createdAt(),
});

/** Metadata only. Bytes live in the AttachmentStore, never in this row. */
export const ticketAttachments = schema.table(
  'ticket_attachments',
  {
    id: pk(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'restrict' }),
    ownerId: text('owner_id').notNull(),
    clientRequestId: text('client_request_id').notNull(),
    storeKey: text('store_key').notNull(),
    contentType: text('content_type').notNull(),
    byteLength: integer('byte_length').notNull(),
    scanState: text('scan_state').$type<'scanning' | 'clean' | 'blocked'>().notNull().default('clean'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ticket_attachments_owner_request_idx').on(t.ownerId, t.clientRequestId)],
);

/** One vote per account per article version. A repeat does not update the row. */
export const kbFeedback = schema.table(
  'kb_feedback',
  {
    id: pk(),
    articleId: text('article_id').notNull(),
    version: integer('version').notNull(),
    userId: text('user_id').notNull(),
    helpful: boolean('helpful').notNull(),
    clientRequestId: text('client_request_id').notNull(),
    /** Set when the reader added a comment. Never required for a plain vote. */
    comment: text('comment'),
    /** The request opened from an unhelpful vote, when they asked for one. */
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('kb_feedback_user_article_version_idx').on(t.userId, t.articleId, t.version),
    uniqueIndex('kb_feedback_user_request_idx').on(t.userId, t.clientRequestId),
    index('kb_feedback_reader_at_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * A search that found nothing. The query, a zero count and the time.
 * No reader column: the log must not identify who searched.
 */
export const kbSearchMisses = schema.table('kb_search_misses', {
  id: pk(),
  query: text('query').notNull(),
  resultCount: integer('result_count').notNull().default(0),
  createdAt: createdAt(),
});

/** A click on a search result, keyed by the caller's request id. No reader column. */
export const kbSearchClicks = schema.table(
  'kb_search_clicks',
  {
    id: pk(),
    query: text('query').notNull(),
    articleId: text('article_id').notNull(),
    clientRequestId: text('client_request_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('kb_search_clicks_request_uq').on(t.clientRequestId)],
);
