import { createHash, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type {
  SupportAccountGrounding,
  SupportCaseFile,
  SupportCitation,
  SupportComment,
  SupportKbArticle,
  SupportTicket,
  SupportTicketEvent,
  SupportTicketEventKind,
  SupportTicketStatus,
} from '@intafaced/contracts';
import { assertKbArticle, KbCatalogError, PLATFORM_KB_SPINE, kbVersionOf, toPublicKb } from './kb-catalog.js';
import { checkTransition, isTerminal } from './lifecycle.js';
import { claimTicket, type ClaimResult } from './operator-queue.js';
import { checkSupportSettlement } from './settlement-refuse.js';

/**
 * Ticket persistence — interface + memory + postgres.
 *
 * Tests use MemorySupportStore. Production boots PostgresSupportStore so two
 * replicas behind the edge share one ticket set and claims are exclusive.
 *
 * EVERY STATE CHANGE WRITES ITS OWN AUDIT ROW, IN THE SAME TRANSACTION.
 *
 * There is no `appendEvent` the mutators call afterwards and no
 * `recordAudit(...)` a caller can forget, because the version of this code that
 * had one would eventually grow a path that changed a ticket without recording
 * it — and that path is the only one that matters, since it is the one somebody
 * uses when they would rather there were no record. `create`, `setStatus` and
 * `claimTicket` each write ticket and trail together or write neither.
 *
 * `appendEvent` exists for `grounding_read` alone — a pure read with nothing
 * else to pair. Escalation is different: the case file and the `escalated`
 * trail row are two halves of one fact, so they go through
 * `putCaseFileWithEscalated` (same transaction). A path that wrote the case
 * file and then died before the trail row would leave the desk able to open a
 * file with no record that an escalation happened — which is the gap the trail
 * exists to close. That transaction locks the ticket first. A missing ticket
 * and a closed ticket write neither row. `resolved` is not terminal.
 */

export type CreateTicketRow = {
  userId: string;
  category: SupportTicket['category'];
  subject: string;
  body: string;
  /** Pasted headers of a reported message; only a `phishing` ticket carries them. */
  messageHeaders?: string;
};

/** A create that carries its caller's key, so a replay returns the first ticket. */
export type CreateTicketOnceRow = CreateTicketRow & { clientRequestId: string };

export type AddCommentInput = {
  ticketId: string;
  authorId: string;
  authorRole: 'user' | 'operator';
  body: string;
};

/**
 * Comment write + the lifecycle it may carry.
 *
 * A user reply on `resolved` must reopen the SAME ticket (`resolved → open`)
 * in this same transaction: the lifecycle table already names that edge as
 * the "not fixed" path, and a comment that lands while the ticket stays
 * `resolved` is a reply nobody will see in the shared queue.
 *
 * `closed` is terminal. A user comment there is refused rather than stored
 * as a ghost reply. Operator notes after close are allowed (no reopen).
 */
export type AddCommentResult =
  | {
      readonly status: 'ok';
      readonly comment: SupportComment;
      readonly ticket: SupportTicket;
      readonly reopened: boolean;
    }
  | { readonly status: 'refuse'; readonly reason: 'not_found' | 'terminal' };

export type AppendEventInput = {
  ticketId: string;
  /** Pure read only. Escalation uses `putCaseFileWithEscalated`. */
  kind: Extract<SupportTicketEventKind, 'grounding_read'>;
  actorId: string;
  actorRole: 'user' | 'operator';
  note?: string | null;
};

/**
 * The result of a lifecycle move. A discriminated union rather than
 * `SupportTicket | null`, because the old signature had exactly one failure
 * shape for three different failures — no such ticket, illegal transition, and
 * "it is already that status" — and the caller could only report the first.
 * `settle` means the move would imply a payout. The row stays put and no
 * trail row is written. There is no amount and no ledger entry.
 */
export type SetStatusResult =
  | { readonly status: 'ok'; readonly ticket: SupportTicket }
  | { readonly status: 'refuse'; readonly reason: 'not_found' | 'illegal_transition' | 'same_status' | 'settle' };

/**
 * Case file + escalated trail, or a refusal that wrote neither.
 * `terminal` is `closed` (`isTerminal`). `resolved` is not terminal.
 */
export type PutCaseFileWithEscalatedResult =
  { readonly status: 'ok'; readonly caseFile: SupportCaseFile } | { readonly status: 'refuse'; readonly reason: 'not_found' | 'terminal' };

export type SetStatusInput = {
  ticketId: string;
  status: SupportTicketStatus;
  operatorId: string;
  note?: string | null;
};

export interface SupportStore {
  createTicket(input: CreateTicketRow): Promise<SupportTicket>;
  /**
   * Idempotent create. The first call stores the ticket and its receipt together;
   * a replay with the same key and the same content returns that ticket and writes
   * nothing. The same key with different content throws `support.idempotency_conflict`.
   */
  createTicketOnce(input: CreateTicketOnceRow): Promise<SupportTicket>;
  /** Newest first. Omit `limit` for the full set (tests / internal dumps). */
  listByUser(userId: string, options?: { limit?: number }): Promise<SupportTicket[]>;
  /** Newest first. Omit `limit` for the full set (queue ranking). */
  listAll(options?: { limit?: number }): Promise<SupportTicket[]>;
  findById(ticketId: string): Promise<SupportTicket | null>;
  addComment(input: AddCommentInput): Promise<AddCommentResult>;
  /** Oldest first. Omit `limit` for the full thread (escalation citations / tests). */
  listComments(ticketId: string, options?: { limit?: number }): Promise<SupportComment[]>;
  /**
   * Lifecycle move + its audit row, atomically. Refuses illegal transitions.
   * Also refuses a settle, from the ticket category, the note, and every
   * case-file reason, before the status write. Postgres does that read after
   * `FOR UPDATE`. No ledger entry.
   */
  setStatus(input: SetStatusInput): Promise<SetStatusResult>;
  /**
   * Exclusive operator claim — must be multi-replica safe.
   * Memory: read-modify-write under single process.
   * Postgres: single UPDATE … WHERE assignee free (or self re-claim).
   * Writes an `assigned` audit row in the same transaction as a winning claim.
   */
  claimTicket(input: { ticketId: string; operatorId: string }): Promise<ClaimResult>;
  /** The current assignee returns the ticket to the queue. Anyone else is refused. */
  releaseTicket(input: { ticketId: string; operatorId: string }): Promise<ClaimResult>;
  /** A lead moves the ticket onto a staff member. The service has already checked the role. */
  assignTicket(input: { ticketId: string; operatorId: string; assigneeId: string }): Promise<ClaimResult>;
  /** Non-state-change trail row for a pure read: `grounding_read` only. */
  appendEvent(input: AppendEventInput): Promise<SupportTicketEvent>;
  /** The trail, oldest first. Omit `limit` for the full trail (tests / internal dumps). */
  listEvents(ticketId: string, options?: { limit?: number }): Promise<SupportTicketEvent[]>;
  /**
   * Write a case file alone. Used by Postgres integrity tests that assert the
   * immutability trigger. Production escalation uses `putCaseFileWithEscalated`.
   */
  putCaseFile(caseFile: SupportCaseFile): Promise<SupportCaseFile>;
  /**
   * Case file + `escalated` trail row in ONE transaction. Either both land or
   * neither does — a case file without its trail row is an incomplete desk.
   * Locks the ticket first. Missing and terminal (`closed`) refuse.
   */
  putCaseFileWithEscalated(input: { caseFile: SupportCaseFile; actorId: string; note: string }): Promise<PutCaseFileWithEscalatedResult>;
  /** The most recent case file for a ticket, or null if never escalated. */
  latestCaseFile(ticketId: string): Promise<SupportCaseFile | null>;
  /** Published articles only, never drafts. Omit `limit` for the full catalog (search / tests). */
  listPublishedKb(options?: { limit?: number }): Promise<SupportKbArticle[]>;
  /** One published article, or null when missing / unpublished. */
  getPublishedKb(id: string): Promise<SupportKbArticle | null>;
  /** Every stored version for an id (including after unpublish). Empty when the id never existed. */
  listKbVersions(id: string): Promise<SupportKbArticle[]>;
  /**
   * Insert (baseRevision 0) or update a row. Publish and unpublish both
   * bump revision. Unpublish keeps the stored title and body and stays
   * unpublished. Stale baseRevision refuses.
   */
  putKbRevision(input: PutKbRevisionInput): Promise<PutKbRevisionResult>;
  /**
   * Owner close. Replay of the same client request returns the stored ticket
   * and writes nothing. A transition the lifecycle table refuses writes nothing.
   */
  closeByOwner(input: { userId: string; ticketId: string; clientRequestId: string }): Promise<CloseByOwnerResult>;
  rateByOwner(input: {
    userId: string;
    ticketId: string;
    score: number;
    note?: string | null;
    clientRequestId: string;
  }): Promise<RateByOwnerResult>;
  /** Owner, or an operator when `asOperator` is set. Someone else's ticket is not_found. */
  readRating(input: { userId: string; ticketId: string; asOperator: boolean }): Promise<ReadRatingResult>;
  readReceipt(procedure: string, actorId: string, clientRequestId: string): Promise<unknown | null>;
  recordAttachment(input: {
    id: string;
    userId: string;
    ticketId: string;
    clientRequestId: string;
    storeKey: string;
    contentType: string;
    byteLength: number;
  }): Promise<RecordAttachmentResult>;
  readAttachment(input: { userId: string; attachmentId: string; asOperator: boolean }): Promise<ReadAttachmentResult>;
  recordKbFeedback(input: { userId: string; articleId: string; helpful: boolean; clientRequestId: string }): Promise<RecordFeedbackResult>;
}

export type PutKbRevisionInput =
  | {
      id: string;
      baseRevision: number;
      published: true;
      titleKey: string;
      bodyKey: string;
      category?: string | null;
      tags?: readonly string[] | null;
    }
  | {
      id: string;
      baseRevision: number;
      published: false;
    };

/** Event-trail note bound (`supportTicketEventSchema.note`). A rating note uses the same bound. */
export const RATING_NOTE_MAX = 500;
/** No customer rating range exists on this service. Integers 1 through 5. */
export const RATING_SCORE_MIN = 1;
export const RATING_SCORE_MAX = 5;

export type TicketRating = {
  ticketId: string;
  userId: string;
  score: number;
  note: string | null;
  createdAt: string;
};

export type AttachmentMeta = {
  id: string;
  ticketId: string;
  ownerId: string;
  contentType: string;
  byteLength: number;
  storeKey: string;
  createdAt: string;
};

export type KbFeedbackVote = {
  articleId: string;
  version: number;
  userId: string;
  helpful: boolean;
};

export type CloseByOwnerResult =
  | { readonly status: 'ok'; readonly ticket: SupportTicket }
  | { readonly status: 'refuse'; readonly reason: 'not_found' | 'illegal_transition' | 'same_status' | 'settle' };

export type RateByOwnerResult =
  | { readonly status: 'ok'; readonly rating: TicketRating }
  | { readonly status: 'refuse'; readonly reason: 'not_found' | 'status' | 'already_rated' | 'score' | 'note' };

export type ReadRatingResult =
  { readonly status: 'ok'; readonly rating: TicketRating | null } | { readonly status: 'refuse'; readonly reason: 'not_found' };

export type RecordAttachmentResult =
  | { readonly status: 'ok'; readonly attachment: AttachmentMeta; readonly replay: boolean }
  | { readonly status: 'refuse'; readonly reason: 'not_found' };

export type ReadAttachmentResult =
  { readonly status: 'ok'; readonly attachment: AttachmentMeta } | { readonly status: 'refuse'; readonly reason: 'not_found' };

export type RecordFeedbackResult =
  { readonly status: 'ok'; readonly vote: KbFeedbackVote } | { readonly status: 'refuse'; readonly reason: 'not_published' };

export type PutKbRevisionResult =
  | { readonly status: 'ok'; readonly article: SupportKbArticle }
  | { readonly status: 'refuse'; readonly reason: 'revision_stale' | 'invalid' | 'vendor' };

function toIso(d: Date | string): string {
  if (typeof d === 'string') return d;
  return d.toISOString();
}

/**
 * Settlement before the status write. Callers pass every case-file reason,
 * not the newest one. `money_request` anywhere in that list refuses
 * `resolved` and `closed`. A payout note refuses. `deposit_withdraw` to
 * `resolved` refuses from the category. `closed` on `deposit_withdraw` with
 * no payout claim does not. No amount is invented.
 */
function settlementRefusal(input: {
  toStatus: SupportTicketStatus;
  category: SupportTicket['category'];
  note?: string | null;
  reasons: readonly SupportCaseFile['reason'][];
}): SetStatusResult | null {
  const settle = checkSupportSettlement({
    toStatus: input.toStatus,
    category: input.category,
    note: input.note ?? null,
    escalationReasons: input.reasons,
  });
  if (settle.status === 'refuse') return { status: 'refuse', reason: 'settle' };
  return null;
}

type PgTicket = {
  id: string;
  user_id: string;
  category: SupportTicket['category'];
  subject: string;
  body: string;
  message_headers: string | null;
  status: SupportTicketStatus;
  assignee_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type PgComment = {
  id: string;
  ticket_id: string;
  author_id: string;
  author_role: 'user' | 'operator';
  body: string;
  created_at: Date;
};

type CreateReceipt = { fingerprint: string; ticket: SupportTicket };

/** What makes two creates "the same submission": everything the caller chose except the key. */
function createFingerprint(input: CreateTicketRow): string {
  return createHash('sha256')
    .update(JSON.stringify([input.category, input.subject, input.body, input.messageHeaders ?? null]))
    .digest('hex');
}

async function insertTicketWithOpened(tx: TransactionSql, input: CreateTicketRow): Promise<SupportTicket> {
  const rows = await tx<PgTicket[]>`
    INSERT INTO support.tickets (user_id, category, subject, body, message_headers, status)
    VALUES (${input.userId}, ${input.category}, ${input.subject}, ${input.body}, ${input.messageHeaders ?? null}, 'open')
    RETURNING id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
  `;
  const ticket = ticketFromPg(rows[0]!);
  await insertEvent(tx, { ticketId: ticket.id, kind: 'opened', actorId: input.userId, actorRole: 'user' });
  return ticket;
}

function ticketFromPg(row: PgTicket): SupportTicket {
  return {
    id: row.id,
    userId: row.user_id,
    category: row.category,
    subject: row.subject,
    body: row.body,
    ...(row.message_headers != null ? { messageHeaders: row.message_headers } : {}),
    status: row.status,
    assigneeId: row.assignee_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function commentFromPg(row: PgComment): SupportComment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorId: row.author_id,
    authorRole: row.author_role,
    body: row.body,
    createdAt: toIso(row.created_at),
  };
}

type PgEvent = {
  id: string;
  ticket_id: string;
  sequence: number;
  kind: SupportTicketEventKind;
  actor_id: string;
  actor_role: 'user' | 'operator';
  from_status: SupportTicketStatus | null;
  to_status: SupportTicketStatus | null;
  note: string | null;
  occurred_at: Date;
};

function eventFromPg(row: PgEvent): SupportTicketEvent {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    sequence: Number(row.sequence),
    kind: row.kind,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    occurredAt: toIso(row.occurred_at),
  };
}

type PgCaseFile = {
  ticket_id: string;
  escalated_by: string;
  reason: SupportCaseFile['reason'];
  citations: unknown;
  grounding: unknown;
  summary: string;
  created_at: Date;
};

function caseFileFromPg(row: PgCaseFile): SupportCaseFile {
  return {
    ticketId: row.ticket_id,
    escalatedBy: row.escalated_by,
    reason: row.reason,
    citations: row.citations as SupportCitation[],
    grounding: row.grounding as SupportAccountGrounding,
    summary: row.summary,
    createdAt: toIso(row.created_at),
  };
}

type PgKb = {
  id: string;
  title_key: string;
  body_key: string;
  revision: number;
  published: boolean;
  updated_at: Date;
  category?: string | null;
  tags?: string[] | null;
};

function topicOn(article: { category?: string | null; tags?: readonly string[] | null }): { category?: string; tags?: string[] } {
  const category = article.category?.trim() ?? '';
  const tags = (article.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  return {
    ...(category ? { category } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

function kbFromPg(row: PgKb): SupportKbArticle {
  const revision = Number(row.revision);
  return toPublicKb({
    id: row.id,
    titleKey: row.title_key,
    bodyKey: row.body_key,
    version: revision,
    revision,
    published: row.published,
    ...topicOn(row),
  });
}

type PgKbVersion = {
  id: string;
  title_key: string;
  body_key: string;
  version: number;
  category?: string | null;
  tags?: string[] | null;
};

function kbFromVersionPg(row: PgKbVersion): SupportKbArticle {
  const version = Number(row.version);
  return toPublicKb({
    id: row.id,
    titleKey: row.title_key,
    bodyKey: row.body_key,
    version,
    revision: version,
    ...topicOn(row),
  });
}

function assertPersistable(article: Pick<SupportKbArticle, 'id' | 'titleKey' | 'bodyKey'>): PutKbRevisionResult | null {
  try {
    assertKbArticle({ id: article.id, titleKey: article.titleKey, bodyKey: article.bodyKey });
    return null;
  } catch (err) {
    if (err instanceof KbCatalogError) {
      return { status: 'refuse', reason: err.code === 'support.kb_vendor_name' ? 'vendor' : 'invalid' };
    }
    throw err;
  }
}

/**
 * Append one trail row, taking the next dense sequence for this ticket.
 *
 * The `SELECT COALESCE(MAX(sequence),0)+1` is a read-then-write and therefore
 * racy — and the unique index `ticket_events_ticket_sequence_idx` is what makes
 * that safe rather than what makes it a bug. Two concurrent writers pick the
 * same number and the second INSERT violates the index, aborting its
 * transaction and rolling back the state change it was recording. The failure
 * mode is a refused operation, never a ticket that moved without a trail row or
 * a trail whose ordering was silently invented.
 *
 * Takes the transaction handle rather than `this.sql` so a caller physically
 * cannot write the audit row outside the transaction it belongs to.
 */
async function insertEvent(
  tx: TransactionSql,
  input: {
    ticketId: string;
    kind: SupportTicketEventKind;
    actorId: string;
    actorRole: 'user' | 'operator';
    fromStatus?: SupportTicketStatus | null;
    toStatus?: SupportTicketStatus | null;
    note?: string | null;
  },
): Promise<SupportTicketEvent> {
  const rows = await tx<PgEvent[]>`
    INSERT INTO support.ticket_events (ticket_id, sequence, kind, actor_id, actor_role, from_status, to_status, note)
    SELECT
      ${input.ticketId},
      COALESCE(MAX(sequence), 0) + 1,
      ${input.kind},
      ${input.actorId},
      ${input.actorRole},
      ${input.fromStatus ?? null},
      ${input.toStatus ?? null},
      ${input.note ?? null}
    FROM support.ticket_events
    WHERE ticket_id = ${input.ticketId}
    RETURNING id, ticket_id, sequence, kind, actor_id, actor_role, from_status, to_status, note, occurred_at
  `;
  return eventFromPg(rows[0]!);
}

/**
 * In-memory store for unit tests — same claim/list semantics as Postgres
 * for a single process. Not multi-replica safe (that is why production uses PG).
 */
export class MemorySupportStore implements SupportStore {
  private readonly tickets = new Map<string, SupportTicket>();
  private readonly comments = new Map<string, SupportComment[]>();
  private readonly events = new Map<string, SupportTicketEvent[]>();
  private readonly cases = new Map<string, SupportCaseFile[]>();
  private readonly kb = new Map<string, SupportKbArticle>();
  private readonly kbVersions = new Map<string, SupportKbArticle[]>();
  private readonly receipts = new Map<string, unknown>();
  private readonly ratings = new Map<string, TicketRating & { clientRequestId: string }>();
  private readonly attachments = new Map<string, AttachmentMeta & { clientRequestId: string }>();
  private readonly feedback = new Map<string, KbFeedbackVote & { clientRequestId: string }>();

  constructor() {
    for (const article of PLATFORM_KB_SPINE) {
      const row = toPublicKb({
        ...article,
        revision: article.revision ?? 1,
        published: article.published ?? true,
      });
      this.kb.set(article.id, row);
      this.kbVersions.set(article.id, [{ ...row }]);
    }
  }

  /** Dense per ticket — the array length IS the sequence, single process. */
  private record(input: {
    ticketId: string;
    kind: SupportTicketEventKind;
    actorId: string;
    actorRole: 'user' | 'operator';
    fromStatus?: SupportTicketStatus | null;
    toStatus?: SupportTicketStatus | null;
    note?: string | null;
    at?: string;
  }): SupportTicketEvent {
    const trail = this.events.get(input.ticketId) ?? [];
    const event: SupportTicketEvent = {
      id: randomUUID(),
      ticketId: input.ticketId,
      sequence: trail.length + 1,
      kind: input.kind,
      actorId: input.actorId,
      actorRole: input.actorRole,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      note: input.note ?? null,
      occurredAt: input.at ?? new Date().toISOString(),
    };
    trail.push(event);
    this.events.set(input.ticketId, trail);
    return event;
  }

  async createTicket(input: CreateTicketRow): Promise<SupportTicket> {
    const now = new Date().toISOString();
    const ticket: SupportTicket = {
      id: randomUUID(),
      userId: input.userId,
      category: input.category,
      subject: input.subject,
      body: input.body,
      ...(input.messageHeaders !== undefined ? { messageHeaders: input.messageHeaders } : {}),
      status: 'open',
      assigneeId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tickets.set(ticket.id, ticket);
    this.comments.set(ticket.id, []);
    this.events.set(ticket.id, []);
    this.record({ ticketId: ticket.id, kind: 'opened', actorId: input.userId, actorRole: 'user', at: now });
    return ticket;
  }

  async createTicketOnce(input: CreateTicketOnceRow): Promise<SupportTicket> {
    const key = this.receiptKey('support.create', input.userId, input.clientRequestId);
    const fingerprint = createFingerprint(input);
    const prior = this.receipts.get(key) as CreateReceipt | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('support.idempotency_conflict');
      return prior.ticket;
    }
    const ticket = await this.createTicket(input);
    this.receipts.set(key, { fingerprint, ticket } satisfies CreateReceipt);
    return ticket;
  }

  async listByUser(userId: string, options?: { limit?: number }): Promise<SupportTicket[]> {
    const rows = [...this.tickets.values()].filter((t) => t.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return options?.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  async listAll(options?: { limit?: number }): Promise<SupportTicket[]> {
    const rows = [...this.tickets.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return options?.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  async findById(ticketId: string): Promise<SupportTicket | null> {
    return this.tickets.get(ticketId) ?? null;
  }

  async addComment(input: AddCommentInput): Promise<AddCommentResult> {
    const ticket = this.tickets.get(input.ticketId);
    if (!ticket) return { status: 'refuse', reason: 'not_found' };
    // Closed is terminal for the owner. An operator note after close is a
    // desk annotation, not a reopen, so it is allowed.
    if (ticket.status === 'closed' && input.authorRole === 'user') {
      return { status: 'refuse', reason: 'terminal' };
    }

    const now = new Date().toISOString();
    const comment: SupportComment = {
      id: randomUUID(),
      ticketId: input.ticketId,
      authorId: input.authorId,
      authorRole: input.authorRole,
      body: input.body,
      createdAt: now,
    };
    const list = this.comments.get(input.ticketId) ?? [];
    list.push(comment);
    this.comments.set(input.ticketId, list);

    const reopened = ticket.status === 'resolved' && input.authorRole === 'user';
    // A customer reply on a request the team had in progress or on hold puts it back in the open queue;
    // whoever holds it keeps it.
    const resumed = (ticket.status === 'pending' || ticket.status === 'on_hold') && input.authorRole === 'user';
    const updated: SupportTicket = reopened
      ? { ...ticket, status: 'open', assigneeId: null, updatedAt: now }
      : resumed
        ? { ...ticket, status: 'open', updatedAt: now }
        : { ...ticket, updatedAt: now };
    this.tickets.set(ticket.id, updated);

    if (resumed) {
      this.record({
        ticketId: ticket.id,
        kind: 'status_changed',
        actorId: input.authorId,
        actorRole: 'user',
        fromStatus: ticket.status,
        toStatus: 'open',
        note: 'user_reply_resume',
        at: now,
      });
    }
    if (reopened) {
      this.record({
        ticketId: ticket.id,
        kind: 'status_changed',
        actorId: input.authorId,
        actorRole: 'user',
        fromStatus: 'resolved',
        toStatus: 'open',
        note: 'user_reply_reopen',
        at: now,
      });
    }
    return { status: 'ok', comment, ticket: updated, reopened };
  }

  async listComments(ticketId: string, options?: { limit?: number }): Promise<SupportComment[]> {
    const rows = [...(this.comments.get(ticketId) ?? [])];
    return options?.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  async setStatus(input: SetStatusInput): Promise<SetStatusResult> {
    const ticket = this.tickets.get(input.ticketId);
    if (!ticket) return { status: 'refuse', reason: 'not_found' };

    const reasons = (this.cases.get(input.ticketId) ?? []).map((file) => file.reason);
    const settle = settlementRefusal({
      toStatus: input.status,
      category: ticket.category,
      note: input.note,
      reasons,
    });
    if (settle) return settle;

    const check = checkTransition(ticket.status, input.status);
    if (check.status === 'refuse') {
      return { status: 'refuse', reason: check.reason === 'same_status' ? 'same_status' : 'illegal_transition' };
    }

    const now = new Date().toISOString();
    const updated: SupportTicket = { ...ticket, status: input.status, updatedAt: now };
    this.tickets.set(input.ticketId, updated);
    this.record({
      ticketId: input.ticketId,
      kind: 'status_changed',
      actorId: input.operatorId,
      actorRole: 'operator',
      fromStatus: ticket.status,
      toStatus: input.status,
      note: input.note ?? null,
      at: now,
    });
    return { status: 'ok', ticket: updated };
  }

  async claimTicket(input: { ticketId: string; operatorId: string }): Promise<ClaimResult> {
    const before = this.tickets.get(input.ticketId);
    const result = claimTicket({
      tickets: [...this.tickets.values()],
      ticketId: input.ticketId,
      operatorId: input.operatorId,
    });
    if (result.status === 'ok') {
      const alreadyMine = before?.assigneeId === input.operatorId;
      this.tickets.set(result.ticket.id, result.ticket);
      // An idempotent self re-claim changed nothing, so it records nothing —
      // a trail that grows on every refresh of an operator's screen is noise
      // that hides the rows somebody will one day need to read.
      if (!alreadyMine) {
        this.record({
          ticketId: result.ticket.id,
          kind: 'assigned',
          actorId: input.operatorId,
          actorRole: 'operator',
          at: result.ticket.updatedAt,
        });
        if (before && before.status !== result.ticket.status) {
          this.record({
            ticketId: result.ticket.id,
            kind: 'status_changed',
            actorId: input.operatorId,
            actorRole: 'operator',
            fromStatus: before.status,
            toStatus: result.ticket.status,
            at: result.ticket.updatedAt,
          });
        }
      }
    }
    return result;
  }

  async releaseTicket(input: { ticketId: string; operatorId: string }): Promise<ClaimResult> {
    const ticket = this.tickets.get(input.ticketId);
    if (!ticket) return { status: 'refuse', reason: 'not_found' };
    if (ticket.status !== 'open' && ticket.status !== 'pending') return { status: 'refuse', reason: 'not_queueable' };
    if (ticket.assigneeId !== input.operatorId) return { status: 'refuse', reason: 'not_assignee' };
    const updated = { ...ticket, assigneeId: null, updatedAt: new Date().toISOString() };
    this.tickets.set(ticket.id, updated);
    this.record({
      ticketId: ticket.id,
      kind: 'assigned',
      actorId: input.operatorId,
      actorRole: 'operator',
      note: 'unclaim',
      at: updated.updatedAt,
    });
    return { status: 'ok', ticket: updated };
  }

  async assignTicket(input: { ticketId: string; operatorId: string; assigneeId: string }): Promise<ClaimResult> {
    const ticket = this.tickets.get(input.ticketId);
    if (!ticket) return { status: 'refuse', reason: 'not_found' };
    if (ticket.status !== 'open' && ticket.status !== 'pending') return { status: 'refuse', reason: 'not_queueable' };
    if (ticket.assigneeId === input.assigneeId) return { status: 'ok', ticket };
    const updated = {
      ...ticket,
      assigneeId: input.assigneeId,
      status: ticket.status === 'open' ? 'pending' : ticket.status,
      updatedAt: new Date().toISOString(),
    };
    this.tickets.set(ticket.id, updated);
    this.record({
      ticketId: ticket.id,
      kind: 'assigned',
      actorId: input.operatorId,
      actorRole: 'operator',
      note: `assign:${input.assigneeId}`,
      at: updated.updatedAt,
    });
    return { status: 'ok', ticket: updated };
  }

  async appendEvent(input: AppendEventInput): Promise<SupportTicketEvent> {
    if (!this.tickets.has(input.ticketId)) throw new Error('ticket not found for event');
    return this.record({
      ticketId: input.ticketId,
      kind: input.kind,
      actorId: input.actorId,
      actorRole: input.actorRole,
      note: input.note ?? null,
    });
  }

  async listEvents(ticketId: string, options?: { limit?: number }): Promise<SupportTicketEvent[]> {
    const rows = [...(this.events.get(ticketId) ?? [])].sort((a, b) => a.sequence - b.sequence);
    return options?.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  async putCaseFile(caseFile: SupportCaseFile): Promise<SupportCaseFile> {
    const list = this.cases.get(caseFile.ticketId) ?? [];
    list.push(caseFile);
    this.cases.set(caseFile.ticketId, list);
    return caseFile;
  }

  async putCaseFileWithEscalated(input: {
    caseFile: SupportCaseFile;
    actorId: string;
    note: string;
  }): Promise<PutCaseFileWithEscalatedResult> {
    // Single-process memory: both writes or neither — match the PG transaction.
    // No row lock to take; the status check still sits before either write.
    const ticket = this.tickets.get(input.caseFile.ticketId);
    if (!ticket) return { status: 'refuse', reason: 'not_found' };
    if (isTerminal(ticket.status)) return { status: 'refuse', reason: 'terminal' };
    await this.putCaseFile(input.caseFile);
    try {
      this.record({
        ticketId: input.caseFile.ticketId,
        kind: 'escalated',
        actorId: input.actorId,
        actorRole: 'operator',
        note: input.note,
      });
    } catch (err) {
      const list = this.cases.get(input.caseFile.ticketId) ?? [];
      list.pop();
      this.cases.set(input.caseFile.ticketId, list);
      throw err;
    }
    return { status: 'ok', caseFile: input.caseFile };
  }

  async latestCaseFile(ticketId: string): Promise<SupportCaseFile | null> {
    const list = this.cases.get(ticketId) ?? [];
    return list.length === 0 ? null : list[list.length - 1]!;
  }

  async listPublishedKb(options?: { limit?: number }): Promise<SupportKbArticle[]> {
    const rows = [...this.kb.values()].filter((a) => a.published === true).map((a) => ({ ...a }));
    return options?.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  async getPublishedKb(id: string): Promise<SupportKbArticle | null> {
    const article = this.kb.get(id);
    return article && article.published === true ? { ...article } : null;
  }

  async listKbVersions(id: string): Promise<SupportKbArticle[]> {
    return (this.kbVersions.get(id) ?? []).map((a) => ({ ...a }));
  }

  private rememberVersion(article: SupportKbArticle): void {
    const list = this.kbVersions.get(article.id) ?? [];
    list.push({ ...article });
    this.kbVersions.set(article.id, list);
  }

  async putKbRevision(input: PutKbRevisionInput): Promise<PutKbRevisionResult> {
    const current = this.kb.get(input.id);
    if (input.published) {
      const bad = assertPersistable({ id: input.id, titleKey: input.titleKey, bodyKey: input.bodyKey });
      if (bad) return bad;
      if (!current) {
        if (input.baseRevision !== 0) return { status: 'refuse', reason: 'revision_stale' };
        const created = toPublicKb({
          id: input.id,
          titleKey: input.titleKey,
          bodyKey: input.bodyKey,
          version: 1,
          revision: 1,
          published: true,
          ...topicOn(input),
        });
        this.kb.set(input.id, created);
        this.rememberVersion(created);
        return { status: 'ok', article: { ...created } };
      }
      if (kbVersionOf(current) !== input.baseRevision) return { status: 'refuse', reason: 'revision_stale' };
      const nextVersion = kbVersionOf(current) + 1;
      const next = toPublicKb({
        id: input.id,
        titleKey: input.titleKey,
        bodyKey: input.bodyKey,
        version: nextVersion,
        revision: nextVersion,
        published: true,
        ...topicOn(input),
      });
      this.kb.set(input.id, next);
      this.rememberVersion(next);
      return { status: 'ok', article: { ...next } };
    }

    if (!current) return { status: 'refuse', reason: 'invalid' };
    if (current.revision !== input.baseRevision) return { status: 'refuse', reason: 'revision_stale' };
    // Same CAS as Postgres: hiding bumps revision so the old baseRevision cannot republish.
    const nextRevision = (current.revision ?? kbVersionOf(current)) + 1;
    const hidden = toPublicKb({
      id: current.id,
      titleKey: current.titleKey,
      bodyKey: current.bodyKey,
      version: nextRevision,
      revision: nextRevision,
      published: false,
      ...topicOn(current),
    });
    this.kb.set(input.id, hidden);
    this.rememberVersion(hidden);
    return { status: 'ok', article: { ...hidden } };
  }

  private receiptKey(procedure: string, actorId: string, clientRequestId: string): string {
    return `${procedure}\0${actorId}\0${clientRequestId}`;
  }

  async readReceipt(procedure: string, actorId: string, clientRequestId: string): Promise<unknown | null> {
    return this.receipts.get(this.receiptKey(procedure, actorId, clientRequestId)) ?? null;
  }

  async closeByOwner(input: { userId: string; ticketId: string; clientRequestId: string }): Promise<CloseByOwnerResult> {
    const stored = this.receipts.get(this.receiptKey('support.close', input.userId, input.clientRequestId));
    if (stored) return stored as CloseByOwnerResult;

    const ticket = this.tickets.get(input.ticketId);
    if (!ticket || ticket.userId !== input.userId) return { status: 'refuse', reason: 'not_found' };

    const reasons = (this.cases.get(input.ticketId) ?? []).map((file) => file.reason);
    const settle = settlementRefusal({ toStatus: 'closed', category: ticket.category, note: null, reasons });
    if (settle) return settle;

    const check = checkTransition(ticket.status, 'closed');
    if (check.status === 'refuse') {
      return { status: 'refuse', reason: check.reason === 'same_status' ? 'same_status' : 'illegal_transition' };
    }

    const now = new Date().toISOString();
    const updated: SupportTicket = { ...ticket, status: 'closed', updatedAt: now };
    this.tickets.set(ticket.id, updated);
    this.record({
      ticketId: ticket.id,
      kind: 'status_changed',
      actorId: input.userId,
      actorRole: 'user',
      fromStatus: ticket.status,
      toStatus: 'closed',
      note: null,
      at: now,
    });
    const ok: CloseByOwnerResult = { status: 'ok', ticket: updated };
    this.receipts.set(this.receiptKey('support.close', input.userId, input.clientRequestId), ok);
    return ok;
  }

  async rateByOwner(input: {
    userId: string;
    ticketId: string;
    score: number;
    note?: string | null;
    clientRequestId: string;
  }): Promise<RateByOwnerResult> {
    const stored = this.receipts.get(this.receiptKey('support.rate', input.userId, input.clientRequestId));
    if (stored) return stored as RateByOwnerResult;

    const ticket = this.tickets.get(input.ticketId);
    if (!ticket || ticket.userId !== input.userId) return { status: 'refuse', reason: 'not_found' };

    const existing = this.ratings.get(input.ticketId);
    if (existing) {
      if (existing.clientRequestId === input.clientRequestId) {
        const ok: RateByOwnerResult = { status: 'ok', rating: existing };
        return ok;
      }
      return { status: 'refuse', reason: 'already_rated' };
    }

    if (ticket.status !== 'resolved' && ticket.status !== 'closed') return { status: 'refuse', reason: 'status' };
    if (!Number.isInteger(input.score) || input.score < RATING_SCORE_MIN || input.score > RATING_SCORE_MAX) {
      return { status: 'refuse', reason: 'score' };
    }
    const note = input.note ?? null;
    if (note != null && note.length > RATING_NOTE_MAX) return { status: 'refuse', reason: 'note' };

    const rating: TicketRating & { clientRequestId: string } = {
      ticketId: input.ticketId,
      userId: input.userId,
      score: input.score,
      note,
      createdAt: new Date().toISOString(),
      clientRequestId: input.clientRequestId,
    };
    this.ratings.set(input.ticketId, rating);
    const ok: RateByOwnerResult = { status: 'ok', rating };
    this.receipts.set(this.receiptKey('support.rate', input.userId, input.clientRequestId), ok);
    return ok;
  }

  async readRating(input: { userId: string; ticketId: string; asOperator: boolean }): Promise<ReadRatingResult> {
    const ticket = this.tickets.get(input.ticketId);
    if (!ticket) return { status: 'refuse', reason: 'not_found' };
    if (!input.asOperator && ticket.userId !== input.userId) return { status: 'refuse', reason: 'not_found' };
    const rating = this.ratings.get(input.ticketId) ?? null;
    return { status: 'ok', rating };
  }

  async recordAttachment(input: {
    id: string;
    userId: string;
    ticketId: string;
    clientRequestId: string;
    storeKey: string;
    contentType: string;
    byteLength: number;
  }): Promise<RecordAttachmentResult> {
    const stored = this.receipts.get(this.receiptKey('support.attach', input.userId, input.clientRequestId));
    if (stored) return { status: 'ok', attachment: (stored as { attachment: AttachmentMeta }).attachment, replay: true };

    const ticket = this.tickets.get(input.ticketId);
    if (!ticket || ticket.userId !== input.userId) return { status: 'refuse', reason: 'not_found' };

    const attachment: AttachmentMeta & { clientRequestId: string } = {
      id: input.id,
      ticketId: input.ticketId,
      ownerId: input.userId,
      contentType: input.contentType,
      byteLength: input.byteLength,
      storeKey: input.storeKey,
      createdAt: new Date().toISOString(),
      clientRequestId: input.clientRequestId,
    };
    this.attachments.set(attachment.id, attachment);
    this.receipts.set(this.receiptKey('support.attach', input.userId, input.clientRequestId), { attachment });
    return { status: 'ok', attachment, replay: false };
  }

  async readAttachment(input: { userId: string; attachmentId: string; asOperator: boolean }): Promise<ReadAttachmentResult> {
    const attachment = this.attachments.get(input.attachmentId);
    if (!attachment) return { status: 'refuse', reason: 'not_found' };
    const ticket = this.tickets.get(attachment.ticketId);
    if (!ticket) return { status: 'refuse', reason: 'not_found' };
    if (attachment.ownerId === input.userId) return { status: 'ok', attachment };
    if (input.asOperator && ticket.assigneeId === input.userId) return { status: 'ok', attachment };
    return { status: 'refuse', reason: 'not_found' };
  }

  async recordKbFeedback(input: {
    userId: string;
    articleId: string;
    helpful: boolean;
    clientRequestId: string;
  }): Promise<RecordFeedbackResult> {
    const stored = this.receipts.get(this.receiptKey('support.kbFeedback', input.userId, input.clientRequestId));
    if (stored) return stored as RecordFeedbackResult;

    const article = this.kb.get(input.articleId);
    if (!article || article.published !== true) return { status: 'refuse', reason: 'not_published' };
    const version = kbVersionOf(article);
    const key = `${input.userId}\0${input.articleId}\0${version}`;
    const existing = this.feedback.get(key);
    if (existing) {
      const ok: RecordFeedbackResult = { status: 'ok', vote: existing };
      return ok;
    }
    const vote: KbFeedbackVote & { clientRequestId: string } = {
      articleId: input.articleId,
      version,
      userId: input.userId,
      helpful: input.helpful,
      clientRequestId: input.clientRequestId,
    };
    this.feedback.set(key, vote);
    const ok: RecordFeedbackResult = { status: 'ok', vote };
    this.receipts.set(this.receiptKey('support.kbFeedback', input.userId, input.clientRequestId), ok);
    return ok;
  }
}

/**
 * Postgres store — shared across replicas. Claim is one UPDATE that only
 * succeeds when assignee is null or already self (idempotent re-claim).
 */
export class PostgresSupportStore implements SupportStore {
  constructor(private readonly sql: Sql) {}

  /** Ticket + its first trail row, atomically. `opened` is sequence 1, always. */
  async createTicket(input: CreateTicketRow): Promise<SupportTicket> {
    return this.sql.begin(async (tx) => insertTicketWithOpened(tx, input));
  }

  async createTicketOnce(input: CreateTicketOnceRow): Promise<SupportTicket> {
    const fingerprint = createFingerprint(input);
    return this.sql.begin(async (tx) => {
      // Two submissions of one key serialise here; the second then reads the first's receipt.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`support.create:${input.userId.length}:${input.userId}:${input.clientRequestId}`}, 0))`;
      const prior = await tx<{ result: CreateReceipt }[]>`
        SELECT result FROM support.write_receipts
        WHERE procedure = 'support.create' AND actor_id = ${input.userId} AND client_request_id = ${input.clientRequestId}
        LIMIT 1
      `;
      if (prior[0]) {
        if (prior[0].result.fingerprint !== fingerprint) throw new Error('support.idempotency_conflict');
        return prior[0].result.ticket;
      }
      const ticket = await insertTicketWithOpened(tx, input);
      await tx`
        INSERT INTO support.write_receipts (procedure, actor_id, client_request_id, result)
        VALUES ('support.create', ${input.userId}, ${input.clientRequestId}, ${tx.json({ fingerprint, ticket } as never)})
      `;
      return ticket;
    });
  }

  async listByUser(userId: string, options?: { limit?: number }): Promise<SupportTicket[]> {
    const rows =
      options?.limit === undefined
        ? await this.sql<PgTicket[]>`
            SELECT id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
            FROM support.tickets
            WHERE user_id = ${userId}
            ORDER BY created_at DESC
          `
        : await this.sql<PgTicket[]>`
            SELECT id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
            FROM support.tickets
            WHERE user_id = ${userId}
            ORDER BY created_at DESC
            LIMIT ${options.limit}
          `;
    return rows.map(ticketFromPg);
  }

  async listAll(options?: { limit?: number }): Promise<SupportTicket[]> {
    const rows =
      options?.limit === undefined
        ? await this.sql<PgTicket[]>`
            SELECT id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
            FROM support.tickets
            ORDER BY created_at DESC
          `
        : await this.sql<PgTicket[]>`
            SELECT id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
            FROM support.tickets
            ORDER BY created_at DESC
            LIMIT ${options.limit}
          `;
    return rows.map(ticketFromPg);
  }

  async findById(ticketId: string): Promise<SupportTicket | null> {
    const rows = await this.sql<PgTicket[]>`
      SELECT id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
      FROM support.tickets
      WHERE id = ${ticketId}
      LIMIT 1
    `;
    return rows[0] ? ticketFromPg(rows[0]) : null;
  }

  async addComment(input: AddCommentInput): Promise<AddCommentResult> {
    return this.sql.begin(async (tx): Promise<AddCommentResult> => {
      const locked = await tx<PgTicket[]>`
        SELECT id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
        FROM support.tickets
        WHERE id = ${input.ticketId}
        FOR UPDATE
      `;
      if (!locked[0]) return { status: 'refuse', reason: 'not_found' };
      const existing = ticketFromPg(locked[0]);
      if (existing.status === 'closed' && input.authorRole === 'user') {
        return { status: 'refuse', reason: 'terminal' };
      }

      const comments = await tx<PgComment[]>`
        INSERT INTO support.comments (ticket_id, author_id, author_role, body)
        VALUES (${input.ticketId}, ${input.authorId}, ${input.authorRole}, ${input.body})
        RETURNING id, ticket_id, author_id, author_role, body, created_at
      `;

      const reopened = existing.status === 'resolved' && input.authorRole === 'user';
      const resumed = (existing.status === 'pending' || existing.status === 'on_hold') && input.authorRole === 'user';
      const rows = reopened
        ? await tx<PgTicket[]>`
            UPDATE support.tickets
            SET status = 'open', assignee_id = NULL, updated_at = now()
            WHERE id = ${input.ticketId}
            RETURNING id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
          `
        : resumed
          ? await tx<PgTicket[]>`
            UPDATE support.tickets
            SET status = 'open', updated_at = now()
            WHERE id = ${input.ticketId}
            RETURNING id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
          `
          : await tx<PgTicket[]>`
            UPDATE support.tickets
            SET updated_at = now()
            WHERE id = ${input.ticketId}
            RETURNING id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
          `;
      if (!rows[0]) return { status: 'refuse', reason: 'not_found' };

      if (resumed) {
        await insertEvent(tx, {
          ticketId: input.ticketId,
          kind: 'status_changed',
          actorId: input.authorId,
          actorRole: 'user',
          fromStatus: existing.status,
          toStatus: 'open',
          note: 'user_reply_resume',
        });
      }
      if (reopened) {
        await insertEvent(tx, {
          ticketId: input.ticketId,
          kind: 'status_changed',
          actorId: input.authorId,
          actorRole: 'user',
          fromStatus: 'resolved',
          toStatus: 'open',
          note: 'user_reply_reopen',
        });
      }

      return {
        status: 'ok',
        comment: commentFromPg(comments[0]!),
        ticket: ticketFromPg(rows[0]),
        reopened,
      };
    });
  }

  async listComments(ticketId: string, options?: { limit?: number }): Promise<SupportComment[]> {
    const rows =
      options?.limit === undefined
        ? await this.sql<PgComment[]>`
            SELECT id, ticket_id, author_id, author_role, body, created_at
            FROM support.comments
            WHERE ticket_id = ${ticketId}
            ORDER BY created_at ASC
          `
        : await this.sql<PgComment[]>`
            SELECT id, ticket_id, author_id, author_role, body, created_at
            FROM support.comments
            WHERE ticket_id = ${ticketId}
            ORDER BY created_at ASC
            LIMIT ${options.limit}
          `;
    return rows.map(commentFromPg);
  }

  /**
   * Lifecycle move + audit row in ONE transaction.
   *
   * `SELECT … FOR UPDATE` and not a bare read: two operators resolving and
   * closing the same ticket at the same instant would otherwise both pass their
   * transition check against the same `open`, and the trail would claim two
   * first moves out of one state. The row lock makes the second wait and then
   * see what the first actually did — so it either refuses (`closed` is
   * terminal) or records `resolved → closed` truthfully.
   *
   * Settlement is the same lock. After `FOR UPDATE`, re-read the ticket and
   * every case-file reason and run `checkSupportSettlement` before the status
   * update. A pre-read of `latestCaseFile` is not the authority: a later
   * `technical` file must not hide an earlier `money_request`, and a
   * `money_request` that commits while this transaction waits must be visible
   * once the lock is held. No ledger write and no amount.
   */
  async setStatus(input: SetStatusInput): Promise<SetStatusResult> {
    return this.sql.begin(async (tx): Promise<SetStatusResult> => {
      const current = await tx<{ status: SupportTicketStatus; category: SupportTicket['category'] }[]>`
        SELECT status, category FROM support.tickets WHERE id = ${input.ticketId} FOR UPDATE
      `;
      const from = current[0]?.status;
      const category = current[0]?.category;
      if (!from || !category) return { status: 'refuse', reason: 'not_found' };

      const reasonRows = await tx<{ reason: SupportCaseFile['reason'] }[]>`
        SELECT reason FROM support.case_files WHERE ticket_id = ${input.ticketId}
      `;
      const settle = settlementRefusal({
        toStatus: input.status,
        category,
        note: input.note,
        reasons: reasonRows.map((row) => row.reason),
      });
      if (settle) return settle;

      const check = checkTransition(from, input.status);
      if (check.status === 'refuse') {
        return { status: 'refuse', reason: check.reason === 'same_status' ? 'same_status' : 'illegal_transition' };
      }

      const rows = await tx<PgTicket[]>`
        UPDATE support.tickets
        SET status = ${input.status}, updated_at = now()
        WHERE id = ${input.ticketId}
        RETURNING id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
      `;
      if (!rows[0]) return { status: 'refuse', reason: 'not_found' };

      await insertEvent(tx, {
        ticketId: input.ticketId,
        kind: 'status_changed',
        actorId: input.operatorId,
        actorRole: 'operator',
        fromStatus: from,
        toStatus: input.status,
        note: input.note ?? null,
      });

      return { status: 'ok', ticket: ticketFromPg(rows[0]) };
    });
  }

  /**
   * Atomic claim: FOR UPDATE + one exclusive UPDATE, trail from the locked row.
   *
   * A pre-read outside the transaction (the previous shape) could see `open`,
   * lose a race to `setStatus(pending)`, then write a trail row claiming
   * `open → pending` when the live move was already recorded. The trail would
   * lie. Locking the ticket row first makes `fromStatus` the status the claim
   * actually moved from.
   */
  async claimTicket(input: { ticketId: string; operatorId: string }): Promise<ClaimResult> {
    const operatorId = input.operatorId?.trim() ?? '';
    if (!operatorId) return { status: 'refuse', reason: 'invalid_operator' };

    return this.sql.begin(async (tx): Promise<ClaimResult> => {
      const locked = await tx<PgTicket[]>`
        SELECT id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
        FROM support.tickets
        WHERE id = ${input.ticketId}
        FOR UPDATE
      `;
      if (!locked[0]) return { status: 'refuse', reason: 'not_found' };
      const existing = ticketFromPg(locked[0]);

      if (existing.status !== 'open' && existing.status !== 'pending') {
        return { status: 'refuse', reason: 'not_queueable' };
      }
      if (existing.assigneeId && existing.assigneeId !== operatorId) {
        return { status: 'refuse', reason: 'already_claimed' };
      }
      // Self re-claim: idempotent, no trail noise on every screen refresh.
      if (existing.assigneeId === operatorId) {
        return { status: 'ok', ticket: existing };
      }

      const claimed = await tx<PgTicket[]>`
        UPDATE support.tickets
        SET
          assignee_id = ${operatorId},
          status = CASE WHEN status = 'open' THEN 'pending' ELSE status END,
          updated_at = now()
        WHERE id = ${input.ticketId}
          AND status IN ('open', 'pending')
          AND (assignee_id IS NULL OR assignee_id = ${operatorId})
        RETURNING id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
      `;
      // Holding FOR UPDATE, this should always return a row when the checks
      // above passed. Zero rows means another writer slipped past — treat as
      // lost claim rather than inventing trail.
      if (claimed.length === 0) return { status: 'refuse', reason: 'already_claimed' };

      await insertEvent(tx, { ticketId: input.ticketId, kind: 'assigned', actorId: operatorId, actorRole: 'operator' });
      // fromStatus comes from the locked row, not a pre-transaction snapshot.
      if (existing.status !== claimed[0]!.status) {
        await insertEvent(tx, {
          ticketId: input.ticketId,
          kind: 'status_changed',
          actorId: operatorId,
          actorRole: 'operator',
          fromStatus: existing.status,
          toStatus: claimed[0]!.status,
        });
      }
      return { status: 'ok', ticket: ticketFromPg(claimed[0]!) };
    });
  }

  async releaseTicket(input: { ticketId: string; operatorId: string }): Promise<ClaimResult> {
    const operatorId = input.operatorId?.trim() ?? '';
    if (!operatorId) return { status: 'refuse', reason: 'invalid_operator' };
    return this.sql.begin(async (tx): Promise<ClaimResult> => {
      const locked = await tx<PgTicket[]>`
        SELECT id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
        FROM support.tickets WHERE id = ${input.ticketId} FOR UPDATE
      `;
      if (!locked[0]) return { status: 'refuse', reason: 'not_found' };
      const existing = ticketFromPg(locked[0]);
      if (existing.status !== 'open' && existing.status !== 'pending') return { status: 'refuse', reason: 'not_queueable' };
      if (existing.assigneeId !== operatorId) return { status: 'refuse', reason: 'not_assignee' };
      const released = await tx<PgTicket[]>`
        UPDATE support.tickets
        SET assignee_id = NULL, updated_at = now()
        WHERE id = ${input.ticketId} AND assignee_id = ${operatorId}
        RETURNING id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
      `;
      if (!released[0]) return { status: 'refuse', reason: 'not_assignee' };
      await insertEvent(tx, {
        ticketId: input.ticketId,
        kind: 'assigned',
        actorId: operatorId,
        actorRole: 'operator',
        note: 'unclaim',
      });
      return { status: 'ok', ticket: ticketFromPg(released[0]) };
    });
  }

  async assignTicket(input: { ticketId: string; operatorId: string; assigneeId: string }): Promise<ClaimResult> {
    const operatorId = input.operatorId?.trim() ?? '';
    const assigneeId = input.assigneeId?.trim() ?? '';
    if (!operatorId || !assigneeId) return { status: 'refuse', reason: 'invalid_operator' };
    return this.sql.begin(async (tx): Promise<ClaimResult> => {
      const locked = await tx<PgTicket[]>`
        SELECT id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
        FROM support.tickets WHERE id = ${input.ticketId} FOR UPDATE
      `;
      if (!locked[0]) return { status: 'refuse', reason: 'not_found' };
      const existing = ticketFromPg(locked[0]);
      if (existing.status !== 'open' && existing.status !== 'pending') return { status: 'refuse', reason: 'not_queueable' };
      if (existing.assigneeId === assigneeId) return { status: 'ok', ticket: existing };
      const assigned = await tx<PgTicket[]>`
        UPDATE support.tickets
        SET assignee_id = ${assigneeId},
            status = CASE WHEN status = 'open' THEN 'pending' ELSE status END,
            updated_at = now()
        WHERE id = ${input.ticketId}
        RETURNING id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
      `;
      if (!assigned[0]) return { status: 'refuse', reason: 'not_found' };
      await insertEvent(tx, {
        ticketId: input.ticketId,
        kind: 'assigned',
        actorId: operatorId,
        actorRole: 'operator',
        note: `assign:${assigneeId}`,
      });
      return { status: 'ok', ticket: ticketFromPg(assigned[0]) };
    });
  }

  /**
   * Trail rows that record a READ or a hand-off rather than a state change, so
   * there is nothing to be atomic with. Still goes through `insertEvent`, so it
   * takes the same dense sequence and hits the same unique index.
   */
  async appendEvent(input: AppendEventInput): Promise<SupportTicketEvent> {
    return this.sql.begin(async (tx) =>
      insertEvent(tx, {
        ticketId: input.ticketId,
        kind: input.kind,
        actorId: input.actorId,
        actorRole: input.actorRole,
        note: input.note ?? null,
      }),
    );
  }

  /** Ordered by `sequence`, not `occurred_at` — two rows can share a timestamp. */
  async listEvents(ticketId: string, options?: { limit?: number }): Promise<SupportTicketEvent[]> {
    const rows =
      options?.limit === undefined
        ? await this.sql<PgEvent[]>`
            SELECT id, ticket_id, sequence, kind, actor_id, actor_role, from_status, to_status, note, occurred_at
            FROM support.ticket_events
            WHERE ticket_id = ${ticketId}
            ORDER BY sequence ASC
          `
        : await this.sql<PgEvent[]>`
            SELECT id, ticket_id, sequence, kind, actor_id, actor_role, from_status, to_status, note, occurred_at
            FROM support.ticket_events
            WHERE ticket_id = ${ticketId}
            ORDER BY sequence ASC
            LIMIT ${options.limit}
          `;
    return rows.map(eventFromPg);
  }

  async putCaseFile(caseFile: SupportCaseFile): Promise<SupportCaseFile> {
    const rows = await this.sql<PgCaseFile[]>`
      INSERT INTO support.case_files (ticket_id, escalated_by, reason, citations, grounding, summary)
      VALUES (
        ${caseFile.ticketId},
        ${caseFile.escalatedBy},
        ${caseFile.reason},
        ${this.sql.json(caseFile.citations as never)},
        ${this.sql.json(caseFile.grounding as never)},
        ${caseFile.summary}
      )
      RETURNING ticket_id, escalated_by, reason, citations, grounding, summary, created_at
    `;
    return caseFileFromPg(rows[0]!);
  }

  /**
   * Case file + escalated trail row, or neither. `SELECT … FOR UPDATE` before
   * the insert, same as `setStatus`. escalate's `isTerminal` check is a
   * pre-read: identity and KB work sit between it and this write, so a
   * concurrent close can commit first. The locked status is the one that
   * decides. `closed` refuses. `resolved` does not.
   */
  async putCaseFileWithEscalated(input: {
    caseFile: SupportCaseFile;
    actorId: string;
    note: string;
  }): Promise<PutCaseFileWithEscalatedResult> {
    return this.sql.begin(async (tx): Promise<PutCaseFileWithEscalatedResult> => {
      const current = await tx<{ status: SupportTicketStatus }[]>`
        SELECT status FROM support.tickets WHERE id = ${input.caseFile.ticketId} FOR UPDATE
      `;
      const from = current[0]?.status;
      if (!from) return { status: 'refuse', reason: 'not_found' };
      if (isTerminal(from)) return { status: 'refuse', reason: 'terminal' };

      const rows = await tx<PgCaseFile[]>`
        INSERT INTO support.case_files (ticket_id, escalated_by, reason, citations, grounding, summary)
        VALUES (
          ${input.caseFile.ticketId},
          ${input.caseFile.escalatedBy},
          ${input.caseFile.reason},
          ${tx.json(input.caseFile.citations as never)},
          ${tx.json(input.caseFile.grounding as never)},
          ${input.caseFile.summary}
        )
        RETURNING ticket_id, escalated_by, reason, citations, grounding, summary, created_at
      `;
      await insertEvent(tx, {
        ticketId: input.caseFile.ticketId,
        kind: 'escalated',
        actorId: input.actorId,
        actorRole: 'operator',
        note: input.note,
      });
      return { status: 'ok', caseFile: caseFileFromPg(rows[0]!) };
    });
  }

  async latestCaseFile(ticketId: string): Promise<SupportCaseFile | null> {
    const rows = await this.sql<PgCaseFile[]>`
      SELECT ticket_id, escalated_by, reason, citations, grounding, summary, created_at
      FROM support.case_files
      WHERE ticket_id = ${ticketId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return rows[0] ? caseFileFromPg(rows[0]) : null;
  }

  async listPublishedKb(options?: { limit?: number }): Promise<SupportKbArticle[]> {
    const rows =
      options?.limit === undefined
        ? await this.sql<PgKb[]>`
            SELECT a.id, a.title_key, a.body_key, a.revision, a.published, a.updated_at, v.category, v.tags
            FROM support.kb_articles AS a
            LEFT JOIN support.kb_article_versions AS v ON v.id = a.id AND v.version = a.revision
            WHERE a.published = true
            ORDER BY a.id
          `
        : await this.sql<PgKb[]>`
            SELECT a.id, a.title_key, a.body_key, a.revision, a.published, a.updated_at, v.category, v.tags
            FROM support.kb_articles AS a
            LEFT JOIN support.kb_article_versions AS v ON v.id = a.id AND v.version = a.revision
            WHERE a.published = true
            ORDER BY a.id
            LIMIT ${options.limit}
          `;
    return rows.map(kbFromPg);
  }

  async getPublishedKb(id: string): Promise<SupportKbArticle | null> {
    const rows = await this.sql<PgKb[]>`
      SELECT a.id, a.title_key, a.body_key, a.revision, a.published, a.updated_at, v.category, v.tags
      FROM support.kb_articles AS a
      LEFT JOIN support.kb_article_versions AS v ON v.id = a.id AND v.version = a.revision
      WHERE a.id = ${id} AND a.published = true
      LIMIT 1
    `;
    return rows[0] ? kbFromPg(rows[0]) : null;
  }

  async listKbVersions(id: string): Promise<SupportKbArticle[]> {
    const rows = await this.sql<PgKbVersion[]>`
      SELECT id, title_key, body_key, version, category, tags
      FROM support.kb_article_versions
      WHERE id = ${id}
      ORDER BY version
    `;
    return rows.map(kbFromVersionPg);
  }

  async putKbRevision(input: PutKbRevisionInput): Promise<PutKbRevisionResult> {
    return this.sql.begin(async (tx): Promise<PutKbRevisionResult> => {
      const locked = await tx<PgKb[]>`
        SELECT id, title_key, body_key, revision, published, updated_at
        FROM support.kb_articles
        WHERE id = ${input.id}
        FOR UPDATE
      `;
      const current = locked[0] ? kbFromPg(locked[0]) : null;

      if (input.published) {
        const bad = assertPersistable({ id: input.id, titleKey: input.titleKey, bodyKey: input.bodyKey });
        if (bad) return bad;
        const topic = topicOn(input);
        const category = topic.category ?? null;
        const tags = topic.tags ? tx.json(topic.tags) : null;
        if (!current) {
          if (input.baseRevision !== 0) return { status: 'refuse', reason: 'revision_stale' };
          const rows = await tx<PgKb[]>`
            INSERT INTO support.kb_articles (id, title_key, body_key, revision, published)
            VALUES (${input.id}, ${input.titleKey}, ${input.bodyKey}, 1, true)
            RETURNING id, title_key, body_key, revision, published, updated_at
          `;
          await tx`
            INSERT INTO support.kb_article_versions (id, version, title_key, body_key, category, tags)
            VALUES (${input.id}, 1, ${input.titleKey}, ${input.bodyKey}, ${category}, ${tags})
          `;
          return { status: 'ok', article: toPublicKb({ ...kbFromPg(rows[0]!), ...topic }) };
        }
        if (current.revision !== input.baseRevision) return { status: 'refuse', reason: 'revision_stale' };
        const rows = await tx<PgKb[]>`
          UPDATE support.kb_articles
          SET title_key = ${input.titleKey},
              body_key = ${input.bodyKey},
              revision = revision + 1,
              published = true,
              updated_at = now()
          WHERE id = ${input.id} AND revision = ${input.baseRevision}
          RETURNING id, title_key, body_key, revision, published, updated_at
        `;
        if (!rows[0]) return { status: 'refuse', reason: 'revision_stale' };
        const bumped = kbFromPg(rows[0]);
        await tx`
          INSERT INTO support.kb_article_versions (id, version, title_key, body_key, category, tags)
          VALUES (${input.id}, ${kbVersionOf(bumped)}, ${input.titleKey}, ${input.bodyKey}, ${category}, ${tags})
        `;
        return { status: 'ok', article: toPublicKb({ ...bumped, ...topic }) };
      }

      if (!current) return { status: 'refuse', reason: 'invalid' };
      if (current.revision !== input.baseRevision) return { status: 'refuse', reason: 'revision_stale' };
      const prev = await tx<{ category: string | null; tags: string[] | null }[]>`
        SELECT category, tags
        FROM support.kb_article_versions
        WHERE id = ${input.id} AND version = ${current.revision}
      `;
      const carried = topicOn(prev[0] ?? {});
      const rows = await tx<PgKb[]>`
        UPDATE support.kb_articles
        SET revision = revision + 1,
            published = false,
            updated_at = now()
        WHERE id = ${input.id} AND revision = ${input.baseRevision}
        RETURNING id, title_key, body_key, revision, published, updated_at
      `;
      if (!rows[0]) return { status: 'refuse', reason: 'revision_stale' };
      const hidden = kbFromPg(rows[0]);
      // 0008 refuses a revision change that has no matching version row.
      // Copy the stored keys and the stored topic; do not write a new title or body.
      await tx`
        INSERT INTO support.kb_article_versions (id, version, title_key, body_key, category, tags)
        VALUES (
          ${input.id},
          ${kbVersionOf(hidden)},
          ${hidden.titleKey},
          ${hidden.bodyKey},
          ${carried.category ?? null},
          ${carried.tags ? tx.json(carried.tags) : null}
        )
      `;
      return { status: 'ok', article: toPublicKb({ ...hidden, ...carried }) };
    });
  }

  async readReceipt(procedure: string, actorId: string, clientRequestId: string): Promise<unknown | null> {
    const rows = await this.sql<{ result: unknown }[]>`
      SELECT result FROM support.write_receipts
      WHERE procedure = ${procedure} AND actor_id = ${actorId} AND client_request_id = ${clientRequestId}
      LIMIT 1
    `;
    return rows[0]?.result ?? null;
  }

  async closeByOwner(input: { userId: string; ticketId: string; clientRequestId: string }): Promise<CloseByOwnerResult> {
    return this.sql.begin(async (tx): Promise<CloseByOwnerResult> => {
      const locked = await tx<PgTicket[]>`
        SELECT id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
        FROM support.tickets
        WHERE id = ${input.ticketId}
        FOR UPDATE
      `;
      const prior = await tx<{ result: CloseByOwnerResult }[]>`
        SELECT result FROM support.write_receipts
        WHERE procedure = 'support.close' AND actor_id = ${input.userId} AND client_request_id = ${input.clientRequestId}
        LIMIT 1
      `;
      if (prior[0]) return prior[0].result;

      if (!locked[0] || locked[0].user_id !== input.userId) return { status: 'refuse', reason: 'not_found' };
      const ticket = ticketFromPg(locked[0]);
      const reasonRows = await tx<{ reason: SupportCaseFile['reason'] }[]>`
        SELECT reason FROM support.case_files WHERE ticket_id = ${input.ticketId}
      `;
      const settle = settlementRefusal({
        toStatus: 'closed',
        category: ticket.category,
        note: null,
        reasons: reasonRows.map((row) => row.reason),
      });
      if (settle) return settle;

      const check = checkTransition(ticket.status, 'closed');
      if (check.status === 'refuse') {
        return { status: 'refuse', reason: check.reason === 'same_status' ? 'same_status' : 'illegal_transition' };
      }

      const rows = await tx<PgTicket[]>`
        UPDATE support.tickets
        SET status = 'closed', updated_at = now()
        WHERE id = ${input.ticketId}
        RETURNING id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
      `;
      if (!rows[0]) return { status: 'refuse', reason: 'not_found' };
      await insertEvent(tx, {
        ticketId: input.ticketId,
        kind: 'status_changed',
        actorId: input.userId,
        actorRole: 'user',
        fromStatus: ticket.status,
        toStatus: 'closed',
        note: null,
      });
      const ok: CloseByOwnerResult = { status: 'ok', ticket: ticketFromPg(rows[0]) };
      await tx`
        INSERT INTO support.write_receipts (procedure, actor_id, client_request_id, result)
        VALUES ('support.close', ${input.userId}, ${input.clientRequestId}, ${tx.json(ok as never)})
      `;
      return ok;
    });
  }

  async rateByOwner(input: {
    userId: string;
    ticketId: string;
    score: number;
    note?: string | null;
    clientRequestId: string;
  }): Promise<RateByOwnerResult> {
    return this.sql.begin(async (tx): Promise<RateByOwnerResult> => {
      const locked = await tx<PgTicket[]>`
        SELECT id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
        FROM support.tickets
        WHERE id = ${input.ticketId}
        FOR UPDATE
      `;
      const prior = await tx<{ result: RateByOwnerResult }[]>`
        SELECT result FROM support.write_receipts
        WHERE procedure = 'support.rate' AND actor_id = ${input.userId} AND client_request_id = ${input.clientRequestId}
        LIMIT 1
      `;
      if (prior[0]) return prior[0].result;
      if (!locked[0] || locked[0].user_id !== input.userId) return { status: 'refuse', reason: 'not_found' };

      const existing = await tx<PgRating[]>`
        SELECT ticket_id, user_id, score, note, created_at, client_request_id
        FROM support.ticket_ratings
        WHERE ticket_id = ${input.ticketId}
        LIMIT 1
      `;
      if (existing[0]) {
        if (existing[0].client_request_id === input.clientRequestId) {
          return { status: 'ok', rating: ratingFromPg(existing[0]) };
        }
        return { status: 'refuse', reason: 'already_rated' };
      }

      if (locked[0].status !== 'resolved' && locked[0].status !== 'closed') return { status: 'refuse', reason: 'status' };
      if (!Number.isInteger(input.score) || input.score < RATING_SCORE_MIN || input.score > RATING_SCORE_MAX) {
        return { status: 'refuse', reason: 'score' };
      }
      const note = input.note ?? null;
      if (note != null && note.length > RATING_NOTE_MAX) return { status: 'refuse', reason: 'note' };

      const rows = await tx<PgRating[]>`
        INSERT INTO support.ticket_ratings (ticket_id, user_id, score, note, client_request_id)
        VALUES (${input.ticketId}, ${input.userId}, ${input.score}, ${note}, ${input.clientRequestId})
        RETURNING ticket_id, user_id, score, note, created_at, client_request_id
      `;
      const ok: RateByOwnerResult = { status: 'ok', rating: ratingFromPg(rows[0]!) };
      await tx`
        INSERT INTO support.write_receipts (procedure, actor_id, client_request_id, result)
        VALUES ('support.rate', ${input.userId}, ${input.clientRequestId}, ${tx.json(ok as never)})
      `;
      return ok;
    });
  }

  async readRating(input: { userId: string; ticketId: string; asOperator: boolean }): Promise<ReadRatingResult> {
    const ticket = await this.sql<{ user_id: string }[]>`
      SELECT user_id FROM support.tickets WHERE id = ${input.ticketId} LIMIT 1
    `;
    if (!ticket[0]) return { status: 'refuse', reason: 'not_found' };
    if (!input.asOperator && ticket[0].user_id !== input.userId) return { status: 'refuse', reason: 'not_found' };
    const rows = await this.sql<PgRating[]>`
      SELECT ticket_id, user_id, score, note, created_at, client_request_id
      FROM support.ticket_ratings
      WHERE ticket_id = ${input.ticketId}
      LIMIT 1
    `;
    return { status: 'ok', rating: rows[0] ? ratingFromPg(rows[0]) : null };
  }

  async recordAttachment(input: {
    id: string;
    userId: string;
    ticketId: string;
    clientRequestId: string;
    storeKey: string;
    contentType: string;
    byteLength: number;
  }): Promise<RecordAttachmentResult> {
    return this.sql.begin(async (tx): Promise<RecordAttachmentResult> => {
      const locked = await tx<{ user_id: string }[]>`
        SELECT user_id FROM support.tickets WHERE id = ${input.ticketId} FOR UPDATE
      `;
      const prior = await tx<{ result: { attachment: AttachmentMeta } }[]>`
        SELECT result FROM support.write_receipts
        WHERE procedure = 'support.attach' AND actor_id = ${input.userId} AND client_request_id = ${input.clientRequestId}
        LIMIT 1
      `;
      if (prior[0]) return { status: 'ok', attachment: prior[0].result.attachment, replay: true };
      if (!locked[0] || locked[0].user_id !== input.userId) return { status: 'refuse', reason: 'not_found' };

      const rows = await tx<PgAttachment[]>`
        INSERT INTO support.ticket_attachments (id, ticket_id, owner_id, client_request_id, store_key, content_type, byte_length)
        VALUES (
          ${input.id},
          ${input.ticketId},
          ${input.userId},
          ${input.clientRequestId},
          ${input.storeKey},
          ${input.contentType},
          ${input.byteLength}
        )
        RETURNING id, ticket_id, owner_id, content_type, byte_length, store_key, created_at
      `;
      const attachment = attachmentFromPg(rows[0]!);
      await tx`
        INSERT INTO support.write_receipts (procedure, actor_id, client_request_id, result)
        VALUES ('support.attach', ${input.userId}, ${input.clientRequestId}, ${tx.json({ attachment } as never)})
      `;
      return { status: 'ok', attachment, replay: false };
    });
  }

  async readAttachment(input: { userId: string; attachmentId: string; asOperator: boolean }): Promise<ReadAttachmentResult> {
    const rows = await this.sql<(PgAttachment & { assignee_id: string | null })[]>`
      SELECT a.id, a.ticket_id, a.owner_id, a.content_type, a.byte_length, a.store_key, a.created_at, t.assignee_id
      FROM support.ticket_attachments AS a
      JOIN support.tickets AS t ON t.id = a.ticket_id
      WHERE a.id = ${input.attachmentId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { status: 'refuse', reason: 'not_found' };
    if (row.owner_id === input.userId) return { status: 'ok', attachment: attachmentFromPg(row) };
    if (input.asOperator && row.assignee_id === input.userId) return { status: 'ok', attachment: attachmentFromPg(row) };
    return { status: 'refuse', reason: 'not_found' };
  }

  async recordKbFeedback(input: {
    userId: string;
    articleId: string;
    helpful: boolean;
    clientRequestId: string;
  }): Promise<RecordFeedbackResult> {
    return this.sql.begin(async (tx): Promise<RecordFeedbackResult> => {
      const prior = await tx<{ result: RecordFeedbackResult }[]>`
        SELECT result FROM support.write_receipts
        WHERE procedure = 'support.kbFeedback' AND actor_id = ${input.userId} AND client_request_id = ${input.clientRequestId}
        LIMIT 1
      `;
      if (prior[0]) return prior[0].result;

      const head = await tx<{ revision: number; published: boolean }[]>`
        SELECT revision, published FROM support.kb_articles WHERE id = ${input.articleId} FOR UPDATE
      `;
      if (!head[0] || head[0].published !== true) return { status: 'refuse', reason: 'not_published' };
      const version = Number(head[0].revision);
      const existing = await tx<{ helpful: boolean; version: number }[]>`
        SELECT helpful, version FROM support.kb_feedback
        WHERE user_id = ${input.userId} AND article_id = ${input.articleId} AND version = ${version}
        LIMIT 1
      `;
      if (existing[0]) {
        const ok: RecordFeedbackResult = {
          status: 'ok',
          vote: { articleId: input.articleId, version, userId: input.userId, helpful: existing[0].helpful },
        };
        return ok;
      }
      await tx`
        INSERT INTO support.kb_feedback (article_id, version, user_id, helpful, client_request_id)
        VALUES (${input.articleId}, ${version}, ${input.userId}, ${input.helpful}, ${input.clientRequestId})
      `;
      const ok: RecordFeedbackResult = {
        status: 'ok',
        vote: { articleId: input.articleId, version, userId: input.userId, helpful: input.helpful },
      };
      await tx`
        INSERT INTO support.write_receipts (procedure, actor_id, client_request_id, result)
        VALUES ('support.kbFeedback', ${input.userId}, ${input.clientRequestId}, ${tx.json(ok as never)})
      `;
      return ok;
    });
  }
}

type PgRating = {
  ticket_id: string;
  user_id: string;
  score: number;
  note: string | null;
  created_at: Date;
  client_request_id: string;
};

function ratingFromPg(row: PgRating): TicketRating {
  return {
    ticketId: row.ticket_id,
    userId: row.user_id,
    score: Number(row.score),
    note: row.note,
    createdAt: toIso(row.created_at),
  };
}

type PgAttachment = {
  id: string;
  ticket_id: string;
  owner_id: string;
  content_type: string;
  byte_length: number;
  store_key: string;
  created_at: Date;
};

function attachmentFromPg(row: PgAttachment): AttachmentMeta {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    ownerId: row.owner_id,
    contentType: row.content_type,
    byteLength: Number(row.byte_length),
    storeKey: row.store_key,
    createdAt: toIso(row.created_at),
  };
}
