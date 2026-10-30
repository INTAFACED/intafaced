import { createHash, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type {
  SupportAccountGrounding,
  SupportCaseFile,
  SupportCitation,
  SupportComment,
  SupportKbArticle,
  SupportKbAudience,
  SupportTicket,
  SupportTicketEvent,
  SupportTicketEventKind,
  SupportTicketStatus,
} from '@intafaced/contracts';
import { SUPPORT_KB_STORED_BODY_KEY, SUPPORT_KB_STORED_TITLE_KEY } from '@intafaced/contracts';
import { READER_ACTOR_PREFIX, feedbackRateCutoff, feedbackRequestCopy } from './kb-feedback.js';
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
  /**
   * `internal` is a staff-only note (SP-tickets-05): only an operator writes one, it never reopens, resumes or touches the
   * request (its `updatedAt` stays), and its key is kept apart from replies'. Absent is `public`.
   */
  visibility?: 'public' | 'internal';
  body: string;
  /** The caller's key: a replay answers the first comment and writes nothing. */
  clientRequestId?: string;
  /**
   * How many comments the requester may add to one request; checked under the ticket lock, after a replay. Null is the
   * owner value left blank: a new requester comment refuses `cap_unset`. Operators pass none.
   */
  userCap?: number | null;
  /**
   * The last trail row (`sequence`) the writer had read. A newer row written by someone else refuses `stale` (an account read changes nothing and does not count), checked
   * under the ticket lock after a replay, and nothing is written. Absent: no check (the customer's own replies).
   */
  expectedSequence?: number;
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
      /** True when the key was used before: the first comment, nothing written now. */
      readonly replay?: boolean;
    }
  | { readonly status: 'refuse'; readonly reason: 'not_found' | 'terminal' | 'cap_unset' | 'cap_reached' | 'idempotency_conflict' }
  | { readonly status: 'refuse'; readonly reason: 'stale'; readonly newer: readonly SupportTicketEvent[] };

/** What a comment's key holds: the comment it made and what it was asked to say. */
type CommentReceipt = { fingerprint: string; comment: SupportComment };

function commentFingerprint(input: AddCommentInput): string {
  // A public reply's fingerprint is as it was before notes existed, so a key stored then still answers its reply.
  const said =
    input.visibility === 'internal'
      ? [input.ticketId, input.authorRole, 'internal', input.body]
      : [input.ticketId, input.authorRole, input.body];
  return createHash('sha256').update(JSON.stringify(said)).digest('hex');
}

/** The receipt a comment's key is kept under: a note's apart from a reply's, so one key never answers the other. */
const commentProcedure = (input: AddCommentInput) => (input.visibility === 'internal' ? 'support.note' : 'support.comment');

/** A comment stored in a receipt before notes existed has no visibility: it was a public reply. */
const receiptComment = (comment: SupportComment): SupportComment => ({ ...comment, visibility: comment.visibility ?? 'public' });

/** Refuses a note by anyone but an operator before anything is read or written; the table's check refuses it too. */
function assertNoteAuthor(input: AddCommentInput): void {
  if (input.visibility === 'internal' && input.authorRole !== 'operator') throw new Error('only an operator writes an internal note');
}

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
  | { readonly status: 'refuse'; readonly reason: 'not_found' | 'illegal_transition' | 'same_status' | 'settle' }
  | { readonly status: 'refuse'; readonly reason: 'stale'; readonly newer: readonly SupportTicketEvent[] };

/**
 * The trail rows after `expectedSequence` written by someone other than `actorId`, oldest first: what makes a write that
 * names `expectedSequence` stale. An account read (`grounding_read`) changes nothing and does not count.
 */
export function newerByOthers(events: readonly SupportTicketEvent[], expectedSequence: number, actorId: string): SupportTicketEvent[] {
  return events
    .filter((row) => row.sequence > expectedSequence && row.actorId !== actorId && row.kind !== 'grounding_read')
    .sort((a, b) => a.sequence - b.sequence);
}

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
  /** As on a comment: a newer trail row by someone else refuses `stale`, under the ticket lock, and nothing is written. */
  expectedSequence?: number;
};

/** A merge of a duplicate request (the source) into the one that stays (the survivor). One per source. */
export type TicketMergeRecord = {
  sourceId: string;
  survivorId: string;
  actorId: string;
  reason: string;
  commentsMoved: number;
  attachmentsMoved: number;
  mergedAt: string;
};

/** Both requests below resolved and held by the same requester account. Nothing else allows a merge. */
export function mergeAllowed(
  source: Pick<SupportTicket, 'status' | 'userId'>,
  survivor: Pick<SupportTicket, 'status' | 'userId'>,
): boolean {
  const live = (status: SupportTicketStatus) => status === 'open' || status === 'pending' || status === 'on_hold';
  return live(source.status) && live(survivor.status) && source.userId === survivor.userId;
}

/** `not_allowed` covers a resolved or closed request, two accounts, and a source already merged elsewhere. */
export type MergeTicketsResult =
  | { readonly status: 'ok'; readonly merge: TicketMergeRecord; readonly replay: boolean }
  | { readonly status: 'refuse'; readonly reason: 'not_found' | 'not_allowed' };

export type MergePreviewResult =
  | {
      readonly status: 'ok';
      readonly allowed: boolean;
      readonly alreadyMerged: boolean;
      readonly commentsToMove: number;
      readonly attachmentsToMove: number;
      readonly ratingStays: boolean;
      readonly caseFileStays: boolean;
    }
  | { readonly status: 'refuse'; readonly reason: 'not_found' };

export type MergeTicketsInput = { sourceId: string; survivorId: string; operatorId: string; reason: string };

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
  /** Ids only, never ticket text: the caller's requests that are not resolved or closed. */
  openIdsByUser(userId: string): Promise<string[]>;
  /** Newest first. Omit `limit` for the full set (queue ranking). */
  listAll(options?: { limit?: number }): Promise<SupportTicket[]>;
  findById(ticketId: string): Promise<SupportTicket | null>;
  addComment(input: AddCommentInput): Promise<AddCommentResult>;
  /**
   * Oldest first. Omit `limit` for the full thread (escalation citations / tests). Internal notes are left out inside the
   * query unless `withInternal` is true, so a customer read cannot list one by forgetting a filter (SP-tickets-05).
   */
  listComments(ticketId: string, options?: { limit?: number; withInternal?: boolean }): Promise<SupportComment[]>;
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
  /**
   * Fold a duplicate into a survivor in ONE transaction: comments and files move, the source ends `closed`, a `merged` trail
   * row lands on both. Keyed (source, survivor): a replay returns the stored merge and moves nothing. Both rows are locked
   * (lower id first) so two merges cannot cross.
   */
  mergeTickets(input: MergeTicketsInput): Promise<MergeTicketsResult>;
  /** What a merge would move and what stays on the source. Reads only. */
  previewMerge(input: { sourceId: string; survivorId: string }): Promise<MergePreviewResult>;
  /** The merge that closed this request into another, or null. */
  findMergeBySource(sourceId: string): Promise<TicketMergeRecord | null>;
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
  /** `audiences` keeps only articles of those audiences, before the page; left out, all audiences. */
  listPublishedKb(options?: { limit?: number; audiences?: readonly SupportKbAudience[] }): Promise<SupportKbArticle[]>;
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
   * Change who may read an article. A new generation (revision + 1) that keeps the keys, the topic and the
   * published flag; the same audience again changes nothing and writes no audit row.
   */
  setKbAudience(input: SetKbAudienceStoreInput): Promise<SetKbAudienceResult>;
  /**
   * Save a draft (SP-kb-01): a new immutable version row above the live head, which readers never see. The base must be
   * the newest version, draft or not; a draft keeps the live version's audience.
   */
  saveKbDraft(input: SaveKbDraftInput): Promise<SaveKbDraftResult>;
  /** One draft version, or null. */
  getKbDraft(id: string, revision: number): Promise<KbDraft | null>;
  /** Every version of an article, drafts included, oldest first. */
  listKbHistory(id: string): Promise<KbHistoryRow[]>;
  /**
   * Publish a draft: a new non-draft version copying it, and the head moves there. Refused when any version is newer than
   * the draft (it was edited or published since), so only the newest draft can go live.
   */
  publishKbDraft(input: { id: string; revision: number }): Promise<PublishKbDraftResult>;
  /** Audience changes for one article, oldest first. */
  listKbAudienceChanges(articleId: string): Promise<KbAudienceChange[]>;
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
  /** Every stored rating, for the founder summary. */
  listRatings(): Promise<TicketRating[]>;
  /** Ids of the caller's own tickets that carry a rating, so a list can tell rated from not yet rated. */
  listRatedTicketIdsFor(userId: string): Promise<string[]>;
  readReceipt(procedure: string, actorId: string, clientRequestId: string): Promise<unknown | null>;
  recordAttachment(input: {
    id: string;
    userId: string;
    ticketId: string;
    clientRequestId: string;
    storeKey: string;
    contentType: string;
    byteLength: number;
    /** The owner's file count for one request. A new file is refused once the request already holds this many. */
    maxCount: number;
    /** The operator adding the file for the ticket's owner, or absent when the owner adds it. */
    operatorId?: string;
  }): Promise<RecordAttachmentResult>;
  readAttachment(input: { userId: string; attachmentId: string; asOperator: boolean }): Promise<ReadAttachmentResult>;
  /**
   * Records the scanner's answer for a file still `scanning`. A file that already left `scanning` is returned as it is and
   * never changes again, so a late or repeated answer cannot turn a blocked file clean. Null when there is no such file.
   */
  setAttachmentScanState(input: { attachmentId: string; state: 'clean' | 'blocked' }): Promise<AttachmentMeta | null>;
  /** Files still `scanning`, oldest first, at most `limit`. */
  listScanningAttachments(limit: number): Promise<AttachmentMeta[]>;
  /** Every file on one ticket, oldest first, at most `limit`. The caller has already been allowed to see the ticket. */
  listAttachmentsFor(ticketId: string, limit: number): Promise<AttachmentMeta[]>;
  recordKbFeedback(input: RecordKbFeedbackInput): Promise<RecordFeedbackResult>;
  /** Helpful and unhelpful counts per article version. No reader id. */
  listKbFeedbackSummary(limit: number): Promise<KbFeedbackCount[]>;
  /** A search that found nothing. The row has no reader. */
  recordSearchMiss(input: { query: string; at: string }): Promise<void>;
  listSearchMisses(limit: number): Promise<KbSearchMiss[]>;
  hasSearchClick(clientRequestId: string): Promise<boolean>;
  /** One row per client request id. A repeat stores nothing more. No reader column. */
  recordSearchClick(input: { query: string; articleId: string; clientRequestId: string; at: string }): Promise<void>;
}

/** Text typed in the desk with its section (SP-kb-01). */
export type PutKbRevisionText = { title: string; body: string; language: string; sectionId: string };

/** A saved help-article draft (SP-kb-01): an immutable version row above the live head, not readable by the public. */
export interface KbDraft {
  readonly id: string;
  readonly revision: number;
  readonly authorId: string;
  readonly templateId: string | null;
  readonly title: string;
  readonly body: string;
  readonly language: string;
  readonly sectionId: string;
  readonly tags: readonly string[];
  readonly audience: SupportKbAudience;
  readonly createdAt: string;
}

export interface SaveKbDraftInput {
  readonly id: string;
  /** The newest version the author read, draft or not; 0 for a new article. */
  readonly baseRevision: number;
  readonly authorId: string;
  readonly templateId: string | null;
  readonly title: string;
  readonly body: string;
  readonly language: string;
  readonly sectionId: string;
  readonly tags: readonly string[];
}

export type SaveKbDraftResult = { status: 'ok'; draft: KbDraft } | { status: 'refuse'; reason: 'revision_stale' | 'section_unknown' };

/** One row of an article's history, oldest first: every immutable version, drafts included. */
export interface KbHistoryRow {
  readonly revision: number;
  readonly draft: boolean;
  readonly authorId: string | null;
  readonly title: string | null;
  readonly audience: SupportKbAudience;
  /** True on the version public readers see now. */
  readonly live: boolean;
  readonly createdAt: string | null;
  /** On a version published from a draft, that draft's revision. */
  readonly sourceRevision: number | null;
}

export type PublishKbDraftResult =
  { status: 'ok'; article: SupportKbArticle } | { status: 'refuse'; reason: 'revision_stale' | 'draft_unknown' | 'section_unknown' };

export type PutKbRevisionInput =
  | {
      id: string;
      baseRevision: number;
      published: true;
      titleKey: string;
      bodyKey: string;
      category?: string | null;
      tags?: readonly string[] | null;
      /** Text typed in the desk, with its section (SP-kb-01). Left out for a catalogue-keyed article. */
      text?: PutKbRevisionText;
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

export type AttachmentScanState = 'scanning' | 'clean' | 'blocked';

export type AttachmentMeta = {
  id: string;
  ticketId: string;
  ownerId: string;
  contentType: string;
  byteLength: number;
  storeKey: string;
  createdAt: string;
  scanState: AttachmentScanState;
  /** The operator who added the file for the owner, or null when the owner did. */
  uploadedBy: string | null;
};

export type KbFeedbackVote = {
  articleId: string;
  version: number;
  userId: string;
  helpful: boolean;
  /** Set only when this vote opened a request. Absent otherwise, never null. */
  ticketId?: string;
  /** True when this account had already voted on this version: the first vote stands and nothing was written. */
  earlier?: true;
};

export type KbFeedbackRate = { readonly limit: number; readonly windowSeconds: number };

export type RecordKbFeedbackInput = {
  userId: string;
  articleId: string;
  helpful: boolean;
  clientRequestId: string;
  comment?: string | null;
  openRequest?: boolean;
  /** Absent for a signed-in vote. `'unset'` writes nothing. */
  rate?: KbFeedbackRate | 'unset';
  now?: string;
};

export type KbFeedbackCount = {
  articleId: string;
  version: number;
  helpful: number;
  unhelpful: number;
};

/** A search with no hit. `resultCount` is 0, and there is no reader. */
export type KbSearchMiss = { query: string; at: string; resultCount: 0 };

type StoredFeedback = {
  articleId: string;
  version: number;
  userId: string;
  helpful: boolean;
  clientRequestId: string;
  createdAt: string;
  comment: string | null;
  ticketId?: string;
};

function kbFeedbackWire(row: {
  articleId: string;
  version: number;
  userId: string;
  helpful: boolean;
  ticketId?: string | null;
}): KbFeedbackVote {
  const vote: KbFeedbackVote = {
    articleId: row.articleId,
    version: row.version,
    userId: row.userId,
    helpful: row.helpful,
  };
  if (row.ticketId) vote.ticketId = row.ticketId;
  return vote;
}

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
  | { readonly status: 'refuse'; readonly reason: 'not_found' | 'count_reached' };

export type ReadAttachmentResult =
  { readonly status: 'ok'; readonly attachment: AttachmentMeta } | { readonly status: 'refuse'; readonly reason: 'not_found' };

export type RecordFeedbackResult =
  | { readonly status: 'ok'; readonly vote: KbFeedbackVote }
  | { readonly status: 'refuse'; readonly reason: 'not_published' | 'rate_unset' | 'rate_exceeded' | 'request_invalid' };

export type SetKbAudienceStoreInput = { id: string; baseRevision: number; audience: SupportKbAudience; actorId: string };

export type KbAudienceChange = {
  articleId: string;
  fromAudience: SupportKbAudience;
  toAudience: SupportKbAudience;
  fromRevision: number;
  toRevision: number;
  actorId: string;
  createdAt: string;
};

export type SetKbAudienceResult =
  | { readonly status: 'ok'; readonly article: SupportKbArticle; readonly changed: boolean }
  | { readonly status: 'refuse'; readonly reason: 'revision_stale' | 'invalid' };

export type PutKbRevisionResult =
  | { readonly status: 'ok'; readonly article: SupportKbArticle }
  | { readonly status: 'refuse'; readonly reason: 'revision_stale' | 'invalid' | 'vendor' | 'section_unknown' };

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
}): { readonly status: 'refuse'; readonly reason: 'settle' } | null {
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
  visibility: 'public' | 'internal';
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
    visibility: row.visibility,
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
  audience?: SupportKbAudience | null;
  title?: string | null;
  body?: string | null;
  language?: string | null;
  section_id?: string | null;
};

function topicOn(article: { category?: string | null; tags?: readonly string[] | null }): { category?: string; tags?: string[] } {
  const category = article.category?.trim() ?? '';
  const tags = (article.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  return {
    ...(category ? { category } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/** The desk-typed text of a version row (0032), or nothing for a catalogue-keyed one. */
function textOn(row: {
  title?: string | null;
  body?: string | null;
  language?: string | null;
  section_id?: string | null;
}): Pick<SupportKbArticle, 'title' | 'body' | 'language' | 'sectionId'> {
  return {
    ...(row.title != null && row.body != null && row.language != null ? { title: row.title, body: row.body, language: row.language } : {}),
    ...(row.section_id != null ? { sectionId: row.section_id } : {}),
  };
}

/** The text columns to copy into a new version row, from an article or a stored version. */
function textColumns(article: Pick<SupportKbArticle, 'title' | 'body' | 'language' | 'sectionId'>) {
  return {
    title: article.title ?? null,
    body: article.body ?? null,
    language: article.language ?? null,
    sectionId: article.sectionId ?? null,
  };
}

/** The text fields an article already carries, copied onto its next version. */
function textOf(article: SupportKbArticle): Pick<SupportKbArticle, 'title' | 'body' | 'language' | 'sectionId'> {
  return textOn({ title: article.title, body: article.body, language: article.language, section_id: article.sectionId });
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
    ...(row.audience ? { audience: row.audience } : {}),
    ...textOn(row),
  });
}

type PgVersionCarry = {
  category: string | null;
  tags: string[] | null;
  audience: SupportKbAudience;
  title: string | null;
  body: string | null;
  language: string | null;
  section_id: string | null;
};

type PgKbVersion = {
  id: string;
  title_key: string;
  body_key: string;
  version: number;
  category?: string | null;
  tags?: string[] | null;
  audience?: SupportKbAudience | null;
  title?: string | null;
  body?: string | null;
  language?: string | null;
  section_id?: string | null;
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
    ...(row.audience ? { audience: row.audience } : {}),
    ...textOn(row),
  });
}

/** The number the next version row of an article takes: one past every row, draft or not. */
async function pgNextKbVersion(tx: TransactionSql, id: string): Promise<number> {
  const [row] = await tx<{ next: number }[]>`
    SELECT COALESCE(MAX(version), 0) + 1 AS next FROM support.kb_article_versions WHERE id = ${id}
  `;
  return Number(row!.next);
}

type PgKbDraft = {
  id: string;
  version: number;
  author_id: string;
  template_id: string | null;
  title: string;
  body: string;
  language: string;
  section_id: string;
  tags: string[] | null;
  audience: SupportKbAudience;
  created_at: Date;
};

function kbDraftFromPg(row: PgKbDraft): KbDraft {
  return {
    id: row.id,
    revision: Number(row.version),
    authorId: row.author_id,
    templateId: row.template_id,
    title: row.title,
    body: row.body,
    language: row.language,
    sectionId: row.section_id,
    tags: row.tags ?? [],
    audience: row.audience,
    createdAt: toIso(row.created_at),
  };
}

function assertPersistable(
  article: Pick<SupportKbArticle, 'id' | 'titleKey' | 'bodyKey'>,
  text?: PutKbRevisionText,
): PutKbRevisionResult | null {
  // The stored-text markers name text on the version itself: a publish that carries them carries the text too.
  const marked = article.titleKey === SUPPORT_KB_STORED_TITLE_KEY || article.bodyKey === SUPPORT_KB_STORED_BODY_KEY;
  if (marked !== Boolean(text)) return { status: 'refuse', reason: 'invalid' };
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
/** `newerByOthers` read inside a transaction that already holds the ticket's row lock. */
async function pgNewerByOthers(
  tx: TransactionSql,
  ticketId: string,
  expectedSequence: number,
  actorId: string,
): Promise<SupportTicketEvent[]> {
  const rows = await tx<PgEvent[]>`
    SELECT id, ticket_id, sequence, kind, actor_id, actor_role, from_status, to_status, note, occurred_at
    FROM support.ticket_events
    WHERE ticket_id = ${ticketId} AND sequence > ${expectedSequence} AND actor_id <> ${actorId} AND kind <> 'grounding_read'
    ORDER BY sequence ASC
  `;
  return rows.map(eventFromPg);
}

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

/** The trail note for a merge: names the other request and the operator's reason, inside the 500 bound. */
function mergeNote(direction: 'into' | 'absorbed', otherId: string, reason: string): string {
  return `${direction === 'into' ? 'merged into' : 'absorbed'} ${otherId}: ${reason}`;
}

type PgMerge = {
  source_id: string;
  survivor_id: string;
  actor_id: string;
  reason: string;
  comments_moved: number;
  attachments_moved: number;
  merged_at: Date | string;
};

function mergeFromPg(row: PgMerge): TicketMergeRecord {
  return {
    sourceId: row.source_id,
    survivorId: row.survivor_id,
    actorId: row.actor_id,
    reason: row.reason,
    commentsMoved: row.comments_moved,
    attachmentsMoved: row.attachments_moved,
    mergedAt: toIso(row.merged_at),
  };
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
  private readonly kbDrafts = new Map<string, KbDraft[]>();
  private readonly kbPublishedFrom = new Map<string, { revision: number; authorId: string }>();
  private readonly kbAudienceChanges: KbAudienceChange[] = [];
  private readonly receipts = new Map<string, unknown>();
  private readonly ratings = new Map<string, TicketRating & { clientRequestId: string }>();
  private readonly attachments = new Map<string, AttachmentMeta & { clientRequestId: string }>();
  private readonly merges = new Map<string, TicketMergeRecord>();
  private readonly feedback = new Map<string, StoredFeedback>();
  private readonly searchMisses: KbSearchMiss[] = [];
  private readonly searchClicks = new Map<string, { query: string; articleId: string }>();

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

  async openIdsByUser(userId: string): Promise<string[]> {
    return [...this.tickets.values()]
      .filter((t) => t.userId === userId && t.status !== 'resolved' && t.status !== 'closed')
      .map((t) => t.id);
  }

  async listAll(options?: { limit?: number }): Promise<SupportTicket[]> {
    const rows = [...this.tickets.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return options?.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  async findById(ticketId: string): Promise<SupportTicket | null> {
    return this.tickets.get(ticketId) ?? null;
  }

  async addComment(input: AddCommentInput): Promise<AddCommentResult> {
    assertNoteAuthor(input);
    const ticket = this.tickets.get(input.ticketId);
    if (!ticket) return { status: 'refuse', reason: 'not_found' };
    const key =
      input.clientRequestId === undefined ? null : this.receiptKey(commentProcedure(input), input.authorId, input.clientRequestId);
    const fingerprint = commentFingerprint(input);
    const prior = key === null ? undefined : (this.receipts.get(key) as CommentReceipt | undefined);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return { status: 'refuse', reason: 'idempotency_conflict' };
      return { status: 'ok', comment: receiptComment(prior.comment), ticket, reopened: false, replay: true };
    }
    // Closed is terminal for the owner. An operator note after close is a
    // desk annotation, not a reopen, so it is allowed.
    if (ticket.status === 'closed' && input.authorRole === 'user') {
      return { status: 'refuse', reason: 'terminal' };
    }
    if (input.expectedSequence !== undefined) {
      const newer = newerByOthers(this.events.get(input.ticketId) ?? [], input.expectedSequence, input.authorId);
      if (newer.length > 0) return { status: 'refuse', reason: 'stale', newer };
    }
    if (input.userCap === null && input.authorRole === 'user') return { status: 'refuse', reason: 'cap_unset' };
    if (input.userCap !== undefined && input.userCap !== null && input.authorRole === 'user') {
      const mine = (this.comments.get(input.ticketId) ?? []).filter((c) => c.authorRole === 'user').length;
      if (mine >= input.userCap) return { status: 'refuse', reason: 'cap_reached' };
    }

    const now = new Date().toISOString();
    const comment: SupportComment = {
      id: randomUUID(),
      ticketId: input.ticketId,
      authorId: input.authorId,
      authorRole: input.authorRole,
      visibility: input.visibility ?? 'public',
      body: input.body,
      createdAt: now,
    };
    const list = this.comments.get(input.ticketId) ?? [];
    list.push(comment);
    this.comments.set(input.ticketId, list);
    if (key !== null) this.receipts.set(key, { fingerprint, comment } satisfies CommentReceipt);
    // A note leaves the request as it was: no reopen, no resume, and no new `updatedAt` for the customer to read.
    if (input.visibility === 'internal') return { status: 'ok', comment, ticket, reopened: false };

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

  async listComments(ticketId: string, options?: { limit?: number; withInternal?: boolean }): Promise<SupportComment[]> {
    const rows = (this.comments.get(ticketId) ?? []).filter((c) => options?.withInternal === true || c.visibility === 'public');
    return options?.limit === undefined ? rows : rows.slice(0, options.limit);
  }

  async findMergeBySource(sourceId: string): Promise<TicketMergeRecord | null> {
    return this.merges.get(sourceId) ?? null;
  }

  async previewMerge(input: { sourceId: string; survivorId: string }): Promise<MergePreviewResult> {
    const source = this.tickets.get(input.sourceId);
    const survivor = this.tickets.get(input.survivorId);
    if (!source || !survivor) return { status: 'refuse', reason: 'not_found' };
    const prior = this.merges.get(input.sourceId);
    return {
      status: 'ok',
      allowed: mergeAllowed(source, survivor),
      alreadyMerged: prior?.survivorId === input.survivorId,
      commentsToMove: (this.comments.get(input.sourceId) ?? []).length,
      attachmentsToMove: [...this.attachments.values()].filter((a) => a.ticketId === input.sourceId).length,
      ratingStays: [...this.ratings.values()].some((r) => r.ticketId === input.sourceId),
      caseFileStays: (this.cases.get(input.sourceId) ?? []).length > 0,
    };
  }

  async mergeTickets(input: MergeTicketsInput): Promise<MergeTicketsResult> {
    const source = this.tickets.get(input.sourceId);
    const survivor = this.tickets.get(input.survivorId);
    if (!source || !survivor) return { status: 'refuse', reason: 'not_found' };
    const prior = this.merges.get(input.sourceId);
    if (prior) {
      return prior.survivorId === input.survivorId
        ? { status: 'ok', merge: prior, replay: true }
        : { status: 'refuse', reason: 'not_allowed' };
    }
    if (!mergeAllowed(source, survivor)) return { status: 'refuse', reason: 'not_allowed' };

    const now = new Date().toISOString();
    const moved = this.comments.get(input.sourceId) ?? [];
    this.comments.set(input.sourceId, []);
    this.comments.set(input.survivorId, [
      ...(this.comments.get(input.survivorId) ?? []),
      ...moved.map((c) => ({ ...c, ticketId: input.survivorId })),
    ]);
    let files = 0;
    for (const a of this.attachments.values()) {
      if (a.ticketId === input.sourceId) {
        a.ticketId = input.survivorId;
        files += 1;
      }
    }
    this.tickets.set(input.sourceId, { ...source, status: 'closed', updatedAt: now });
    this.tickets.set(input.survivorId, { ...survivor, updatedAt: now });
    const merge: TicketMergeRecord = {
      sourceId: input.sourceId,
      survivorId: input.survivorId,
      actorId: input.operatorId,
      reason: input.reason,
      commentsMoved: moved.length,
      attachmentsMoved: files,
      mergedAt: now,
    };
    this.merges.set(input.sourceId, merge);
    const base = { actorId: input.operatorId, actorRole: 'operator' as const, at: now };
    this.record({ ...base, ticketId: input.sourceId, kind: 'merged', note: mergeNote('into', input.survivorId, input.reason) });
    this.record({
      ...base,
      ticketId: input.sourceId,
      kind: 'status_changed',
      fromStatus: source.status,
      toStatus: 'closed',
      note: 'merged',
    });
    this.record({ ...base, ticketId: input.survivorId, kind: 'merged', note: mergeNote('absorbed', input.sourceId, input.reason) });
    return { status: 'ok', merge, replay: false };
  }

  async setStatus(input: SetStatusInput): Promise<SetStatusResult> {
    const ticket = this.tickets.get(input.ticketId);
    if (!ticket) return { status: 'refuse', reason: 'not_found' };
    if (input.expectedSequence !== undefined) {
      const newer = newerByOthers(this.events.get(input.ticketId) ?? [], input.expectedSequence, input.operatorId);
      if (newer.length > 0) return { status: 'refuse', reason: 'stale', newer };
    }

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

  async listPublishedKb(options?: { limit?: number; audiences?: readonly SupportKbAudience[] }): Promise<SupportKbArticle[]> {
    const rows = [...this.kb.values()]
      .filter((a) => a.published === true && (!options?.audiences || options.audiences.includes(a.audience ?? 'public')))
      .map((a) => ({ ...a }));
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

  /** One past every version row of the article, draft or not (drafts sit above the head). */
  private nextKbVersion(id: string): number {
    const versions = (this.kbVersions.get(id) ?? []).map((a) => kbVersionOf(a));
    const drafts = (this.kbDrafts.get(id) ?? []).map((d) => d.revision);
    return Math.max(0, ...versions, ...drafts) + 1;
  }

  async putKbRevision(input: PutKbRevisionInput): Promise<PutKbRevisionResult> {
    const current = this.kb.get(input.id);
    const nextNumber = this.nextKbVersion(input.id);
    if (input.published) {
      const bad = assertPersistable({ id: input.id, titleKey: input.titleKey, bodyKey: input.bodyKey }, input.text);
      if (bad) return bad;
      if (!current) {
        if (input.baseRevision !== 0) return { status: 'refuse', reason: 'revision_stale' };
        const created = toPublicKb({
          id: input.id,
          titleKey: input.titleKey,
          bodyKey: input.bodyKey,
          version: nextNumber,
          revision: nextNumber,
          published: true,
          ...topicOn(input),
          audience: 'public',
          ...input.text,
        });
        this.kb.set(input.id, created);
        this.rememberVersion(created);
        return { status: 'ok', article: { ...created } };
      }
      if (kbVersionOf(current) !== input.baseRevision) return { status: 'refuse', reason: 'revision_stale' };
      const nextVersion = nextNumber;
      const next = toPublicKb({
        id: input.id,
        titleKey: input.titleKey,
        bodyKey: input.bodyKey,
        version: nextVersion,
        revision: nextVersion,
        published: true,
        ...topicOn(input),
        audience: current.audience ?? 'public',
        ...input.text,
      });
      this.kb.set(input.id, next);
      this.rememberVersion(next);
      return { status: 'ok', article: { ...next } };
    }

    if (!current) return { status: 'refuse', reason: 'invalid' };
    if (current.revision !== input.baseRevision) return { status: 'refuse', reason: 'revision_stale' };
    // Same CAS as Postgres: hiding bumps revision so the old baseRevision cannot republish.
    const nextRevision = nextNumber;
    const hidden = toPublicKb({
      id: current.id,
      titleKey: current.titleKey,
      bodyKey: current.bodyKey,
      version: nextRevision,
      revision: nextRevision,
      published: false,
      ...topicOn(current),
      audience: current.audience ?? 'public',
      ...textOf(current),
    });
    this.kb.set(input.id, hidden);
    this.rememberVersion(hidden);
    return { status: 'ok', article: { ...hidden } };
  }

  async setKbAudience(input: SetKbAudienceStoreInput): Promise<SetKbAudienceResult> {
    const current = this.kb.get(input.id);
    if (!current) return { status: 'refuse', reason: 'invalid' };
    const revision = kbVersionOf(current);
    if (revision !== input.baseRevision) return { status: 'refuse', reason: 'revision_stale' };
    const from = current.audience ?? 'public';
    if (from === input.audience) return { status: 'ok', article: { ...current }, changed: false };
    const to = this.nextKbVersion(input.id);
    const next = toPublicKb({ ...current, version: to, revision: to, audience: input.audience });
    this.kb.set(input.id, next);
    this.rememberVersion(next);
    this.kbAudienceChanges.push({
      articleId: input.id,
      fromAudience: from,
      toAudience: input.audience,
      fromRevision: revision,
      toRevision: to,
      actorId: input.actorId,
      createdAt: new Date().toISOString(),
    });
    return { status: 'ok', article: { ...next }, changed: true };
  }

  async saveKbDraft(input: SaveKbDraftInput): Promise<SaveKbDraftResult> {
    const next = this.nextKbVersion(input.id);
    if (input.baseRevision !== next - 1) return { status: 'refuse', reason: 'revision_stale' };
    const head = this.kb.get(input.id);
    const draft: KbDraft = {
      id: input.id,
      revision: next,
      authorId: input.authorId,
      templateId: input.templateId,
      title: input.title,
      body: input.body,
      language: input.language,
      sectionId: input.sectionId,
      tags: [...input.tags],
      audience: head?.audience ?? 'public',
      createdAt: new Date().toISOString(),
    };
    this.kbDrafts.set(input.id, [...(this.kbDrafts.get(input.id) ?? []), draft]);
    return { status: 'ok', draft: { ...draft } };
  }

  async getKbDraft(id: string, revision: number): Promise<KbDraft | null> {
    const draft = (this.kbDrafts.get(id) ?? []).find((d) => d.revision === revision);
    return draft ? { ...draft } : null;
  }

  async listKbHistory(id: string): Promise<KbHistoryRow[]> {
    const head = this.kb.get(id);
    const live = head?.published ? kbVersionOf(head) : null;
    const versions: KbHistoryRow[] = (this.kbVersions.get(id) ?? []).map((a) => {
      const from = this.kbPublishedFrom.get(`${id}\0${kbVersionOf(a)}`);
      return {
        revision: kbVersionOf(a),
        draft: false,
        authorId: from?.authorId ?? null,
        title: a.title ?? null,
        audience: a.audience ?? 'public',
        live: kbVersionOf(a) === live,
        createdAt: null,
        sourceRevision: from?.revision ?? null,
      };
    });
    const drafts: KbHistoryRow[] = (this.kbDrafts.get(id) ?? []).map((d) => ({
      revision: d.revision,
      draft: true,
      authorId: d.authorId,
      title: d.title,
      audience: d.audience,
      live: false,
      createdAt: d.createdAt,
      sourceRevision: null,
    }));
    return [...versions, ...drafts].sort((a, b) => a.revision - b.revision);
  }

  async publishKbDraft(input: { id: string; revision: number }): Promise<PublishKbDraftResult> {
    const draft = (this.kbDrafts.get(input.id) ?? []).find((d) => d.revision === input.revision);
    if (!draft) return { status: 'refuse', reason: 'draft_unknown' };
    const next = this.nextKbVersion(input.id);
    if (next !== input.revision + 1) return { status: 'refuse', reason: 'revision_stale' };
    const article = toPublicKb({
      id: input.id,
      titleKey: SUPPORT_KB_STORED_TITLE_KEY,
      bodyKey: SUPPORT_KB_STORED_BODY_KEY,
      version: next,
      revision: next,
      published: true,
      ...topicOn({ tags: draft.tags }),
      audience: draft.audience,
      title: draft.title,
      body: draft.body,
      language: draft.language,
      sectionId: draft.sectionId,
    });
    this.kb.set(input.id, article);
    this.rememberVersion(article);
    this.kbPublishedFrom.set(`${input.id}\0${next}`, { revision: input.revision, authorId: draft.authorId });
    return { status: 'ok', article: { ...article } };
  }

  async listKbAudienceChanges(articleId: string): Promise<KbAudienceChange[]> {
    return this.kbAudienceChanges.filter((c) => c.articleId === articleId).map((c) => ({ ...c }));
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

  async listRatedTicketIdsFor(userId: string): Promise<string[]> {
    return [...this.ratings.values()].filter((rating) => rating.userId === userId).map((rating) => rating.ticketId);
  }

  async listRatings(): Promise<TicketRating[]> {
    return [...this.ratings.values()].map(({ clientRequestId: _clientRequestId, ...rating }) => rating);
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
    maxCount: number;
    operatorId?: string;
  }): Promise<RecordAttachmentResult> {
    const actor = input.operatorId ?? input.userId;
    const stored = this.receipts.get(this.receiptKey('support.attach', actor, input.clientRequestId));
    if (stored) {
      const first = (stored as { attachment: AttachmentMeta }).attachment;
      // The receipt holds what was first answered; the file's state since is read live.
      return { status: 'ok', attachment: this.attachments.get(first.id) ?? first, replay: true };
    }

    const ticket = this.tickets.get(input.ticketId);
    if (!ticket || ticket.userId !== input.userId) return { status: 'refuse', reason: 'not_found' };
    if (input.operatorId !== undefined && ticket.assigneeId !== input.operatorId) return { status: 'refuse', reason: 'not_found' };
    const held = [...this.attachments.values()].filter((a) => a.ticketId === input.ticketId && a.scanState !== 'blocked').length;
    if (held >= input.maxCount) return { status: 'refuse', reason: 'count_reached' };

    const attachment: AttachmentMeta & { clientRequestId: string } = {
      id: input.id,
      ticketId: input.ticketId,
      ownerId: input.userId,
      contentType: input.contentType,
      byteLength: input.byteLength,
      storeKey: input.storeKey,
      scanState: 'scanning',
      uploadedBy: input.operatorId ?? null,
      createdAt: new Date().toISOString(),
      clientRequestId: input.clientRequestId,
    };
    this.attachments.set(attachment.id, attachment);
    this.receipts.set(this.receiptKey('support.attach', actor, input.clientRequestId), { attachment });
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

  async setAttachmentScanState(input: { attachmentId: string; state: 'clean' | 'blocked' }): Promise<AttachmentMeta | null> {
    const attachment = this.attachments.get(input.attachmentId);
    if (!attachment) return null;
    if (attachment.scanState === 'scanning') attachment.scanState = input.state;
    return attachment;
  }

  async listAttachmentsFor(ticketId: string, limit: number): Promise<AttachmentMeta[]> {
    return [...this.attachments.values()]
      .filter((a) => a.ticketId === ticketId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  async listScanningAttachments(limit: number): Promise<AttachmentMeta[]> {
    return [...this.attachments.values()]
      .filter((a) => a.scanState === 'scanning')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  async recordKbFeedback(input: RecordKbFeedbackInput): Promise<RecordFeedbackResult> {
    const stored = this.receipts.get(this.receiptKey('support.kbFeedback', input.userId, input.clientRequestId));
    if (stored) return stored as RecordFeedbackResult;

    const article = this.kb.get(input.articleId);
    if (!article || article.published !== true) return { status: 'refuse', reason: 'not_published' };
    const version = kbVersionOf(article);
    const key = `${input.userId}\0${input.articleId}\0${version}`;
    const existing = this.feedback.get(key);
    if (existing) return { status: 'ok', vote: { ...kbFeedbackWire(existing), earlier: true } };

    const comment = input.comment?.trim() ?? '';
    if (input.openRequest === true && (input.helpful || comment.length === 0 || input.userId.startsWith(READER_ACTOR_PREFIX))) {
      return { status: 'refuse', reason: 'request_invalid' };
    }
    const now = input.now ?? new Date().toISOString();
    if (input.rate === 'unset') return { status: 'refuse', reason: 'rate_unset' };
    if (input.rate) {
      const cutoff = feedbackRateCutoff(now, input.rate.windowSeconds);
      const recent = [...this.feedback.values()].filter((row) => row.userId === input.userId && row.createdAt > cutoff).length;
      if (recent >= input.rate.limit) return { status: 'refuse', reason: 'rate_exceeded' };
    }

    let ticketId: string | undefined;
    if (input.openRequest === true) {
      const copy = feedbackRequestCopy(input.articleId, version, comment);
      const ticket = await this.createTicket({ userId: input.userId, category: 'other', subject: copy.subject, body: copy.body });
      ticketId = ticket.id;
    }
    const row: StoredFeedback = {
      articleId: input.articleId,
      version,
      userId: input.userId,
      helpful: input.helpful,
      clientRequestId: input.clientRequestId,
      createdAt: now,
      comment: comment || null,
      ...(ticketId ? { ticketId } : {}),
    };
    this.feedback.set(key, row);
    const ok: RecordFeedbackResult = { status: 'ok', vote: kbFeedbackWire(row) };
    this.receipts.set(this.receiptKey('support.kbFeedback', input.userId, input.clientRequestId), ok);
    return ok;
  }

  async listKbFeedbackSummary(limit: number): Promise<KbFeedbackCount[]> {
    const grouped = new Map<string, KbFeedbackCount>();
    for (const row of this.feedback.values()) {
      const key = `${row.articleId}\0${row.version}`;
      const current = grouped.get(key) ?? { articleId: row.articleId, version: row.version, helpful: 0, unhelpful: 0 };
      if (row.helpful) current.helpful += 1;
      else current.unhelpful += 1;
      grouped.set(key, current);
    }
    return [...grouped.values()].sort((a, b) => a.articleId.localeCompare(b.articleId) || a.version - b.version).slice(0, limit);
  }

  async recordSearchMiss(input: { query: string; at: string }): Promise<void> {
    this.searchMisses.push({ query: input.query, at: input.at, resultCount: 0 });
  }

  async listSearchMisses(limit: number): Promise<KbSearchMiss[]> {
    return [...this.searchMisses].reverse().slice(0, limit);
  }

  async hasSearchClick(clientRequestId: string): Promise<boolean> {
    return this.searchClicks.has(clientRequestId);
  }

  async recordSearchClick(input: { query: string; articleId: string; clientRequestId: string; at: string }): Promise<void> {
    if (this.searchClicks.has(input.clientRequestId)) return;
    this.searchClicks.set(input.clientRequestId, { query: input.query, articleId: input.articleId });
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

  async openIdsByUser(userId: string): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM support.tickets WHERE user_id = ${userId} AND status NOT IN ('resolved', 'closed')
    `;
    return rows.map((r) => r.id);
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
    assertNoteAuthor(input);
    const procedure = commentProcedure(input);
    return this.sql.begin(async (tx): Promise<AddCommentResult> => {
      const locked = await tx<PgTicket[]>`
        SELECT id, user_id, category, subject, body, message_headers, status, assignee_id, created_at, updated_at
        FROM support.tickets
        WHERE id = ${input.ticketId}
        FOR UPDATE
      `;
      if (!locked[0]) return { status: 'refuse', reason: 'not_found' };
      const existing = ticketFromPg(locked[0]);
      const fingerprint = commentFingerprint(input);
      if (input.clientRequestId !== undefined) {
        // One key used on two requests at once serialises here, not only on the ticket lock.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${procedure}:${input.authorId.length}:${input.authorId}:${input.clientRequestId}`}, 0))`;
        const prior = await tx<{ result: CommentReceipt }[]>`
          SELECT result FROM support.write_receipts
          WHERE procedure = ${procedure} AND actor_id = ${input.authorId} AND client_request_id = ${input.clientRequestId}
          LIMIT 1
        `;
        if (prior[0]) {
          if (prior[0].result.fingerprint !== fingerprint) return { status: 'refuse', reason: 'idempotency_conflict' };
          return { status: 'ok', comment: receiptComment(prior[0].result.comment), ticket: existing, reopened: false, replay: true };
        }
      }
      if (existing.status === 'closed' && input.authorRole === 'user') {
        return { status: 'refuse', reason: 'terminal' };
      }
      if (input.expectedSequence !== undefined) {
        // A status move or claim takes this same ticket lock first, so none can land between this read and the insert below.
        const newer = await pgNewerByOthers(tx, input.ticketId, input.expectedSequence, input.authorId);
        if (newer.length > 0) return { status: 'refuse', reason: 'stale', newer };
      }
      if (input.userCap === null && input.authorRole === 'user') return { status: 'refuse', reason: 'cap_unset' };
      if (input.userCap !== undefined && input.userCap !== null && input.authorRole === 'user') {
        const counted = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM support.comments WHERE ticket_id = ${input.ticketId} AND author_role = 'user'
        `;
        if ((counted[0]?.n ?? 0) >= input.userCap) return { status: 'refuse', reason: 'cap_reached' };
      }

      const comments = await tx<PgComment[]>`
        INSERT INTO support.comments (ticket_id, author_id, author_role, visibility, body)
        VALUES (${input.ticketId}, ${input.authorId}, ${input.authorRole}, ${input.visibility ?? 'public'}, ${input.body})
        RETURNING id, ticket_id, author_id, author_role, visibility, body, created_at
      `;
      if (input.clientRequestId !== undefined) {
        const receipt: CommentReceipt = { fingerprint, comment: commentFromPg(comments[0]!) };
        await tx`
          INSERT INTO support.write_receipts (procedure, actor_id, client_request_id, result)
          VALUES (${procedure}, ${input.authorId}, ${input.clientRequestId}, ${tx.json(receipt as never)})
        `;
      }
      // A note leaves the request as it was: no reopen, no resume, and no new `updated_at` for the customer to read.
      if (input.visibility === 'internal') return { status: 'ok', comment: commentFromPg(comments[0]!), ticket: existing, reopened: false };

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

  async listComments(ticketId: string, options?: { limit?: number; withInternal?: boolean }): Promise<SupportComment[]> {
    // The internal-note filter is in the query, before the limit: a customer's page is never cut short by notes it cannot see.
    const withInternal = options?.withInternal === true;
    const rows =
      options?.limit === undefined
        ? await this.sql<PgComment[]>`
            SELECT id, ticket_id, author_id, author_role, visibility, body, created_at
            FROM support.comments
            WHERE ticket_id = ${ticketId} AND (visibility = 'public' OR ${withInternal})
            ORDER BY created_at ASC
          `
        : await this.sql<PgComment[]>`
            SELECT id, ticket_id, author_id, author_role, visibility, body, created_at
            FROM support.comments
            WHERE ticket_id = ${ticketId} AND (visibility = 'public' OR ${withInternal})
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
  async findMergeBySource(sourceId: string): Promise<TicketMergeRecord | null> {
    const rows = await this.sql<PgMerge[]>`
      SELECT source_id, survivor_id, actor_id, reason, comments_moved, attachments_moved, merged_at
      FROM support.ticket_merges WHERE source_id = ${sourceId}
    `;
    return rows[0] ? mergeFromPg(rows[0]) : null;
  }

  async previewMerge(input: { sourceId: string; survivorId: string }): Promise<MergePreviewResult> {
    const rows = await this.sql<{ id: string; user_id: string; status: SupportTicketStatus }[]>`
      SELECT id, user_id, status FROM support.tickets WHERE id IN (${input.sourceId}, ${input.survivorId})
    `;
    const source = rows.find((r) => r.id === input.sourceId);
    const survivor = rows.find((r) => r.id === input.survivorId);
    if (!source || !survivor) return { status: 'refuse', reason: 'not_found' };
    const [counts] = await this.sql<{ comments: number; files: number; rated: boolean; filed: boolean; merged: boolean }[]>`
      SELECT
        (SELECT count(*)::int FROM support.comments WHERE ticket_id = ${input.sourceId}) AS comments,
        (SELECT count(*)::int FROM support.ticket_attachments WHERE ticket_id = ${input.sourceId}) AS files,
        EXISTS (SELECT 1 FROM support.ticket_ratings WHERE ticket_id = ${input.sourceId}) AS rated,
        EXISTS (SELECT 1 FROM support.case_files WHERE ticket_id = ${input.sourceId}) AS filed,
        EXISTS (SELECT 1 FROM support.ticket_merges WHERE source_id = ${input.sourceId} AND survivor_id = ${input.survivorId}) AS merged
    `;
    return {
      status: 'ok',
      allowed: mergeAllowed({ status: source.status, userId: source.user_id }, { status: survivor.status, userId: survivor.user_id }),
      alreadyMerged: counts?.merged ?? false,
      commentsToMove: counts?.comments ?? 0,
      attachmentsToMove: counts?.files ?? 0,
      ratingStays: counts?.rated ?? false,
      caseFileStays: counts?.filed ?? false,
    };
  }

  async mergeTickets(input: MergeTicketsInput): Promise<MergeTicketsResult> {
    return this.sql.begin(async (tx): Promise<MergeTicketsResult> => {
      // Lower id first, so two merges over the same pair in opposite directions cannot wait on each other.
      const ids = [input.sourceId, input.survivorId].sort();
      const locked = await tx<{ id: string; user_id: string; status: SupportTicketStatus }[]>`
        SELECT id, user_id, status FROM support.tickets WHERE id IN (${ids[0]!}, ${ids[1]!}) ORDER BY id FOR UPDATE
      `;
      const source = locked.find((r) => r.id === input.sourceId);
      const survivor = locked.find((r) => r.id === input.survivorId);
      if (!source || !survivor) return { status: 'refuse', reason: 'not_found' };

      const [prior] = await tx<PgMerge[]>`
        SELECT source_id, survivor_id, actor_id, reason, comments_moved, attachments_moved, merged_at
        FROM support.ticket_merges WHERE source_id = ${input.sourceId}
      `;
      if (prior) {
        return prior.survivor_id === input.survivorId
          ? { status: 'ok', merge: mergeFromPg(prior), replay: true }
          : { status: 'refuse', reason: 'not_allowed' };
      }
      if (!mergeAllowed({ status: source.status, userId: source.user_id }, { status: survivor.status, userId: survivor.user_id })) {
        return { status: 'refuse', reason: 'not_allowed' };
      }

      const comments = await tx`UPDATE support.comments SET ticket_id = ${input.survivorId} WHERE ticket_id = ${input.sourceId}`;
      const files = await tx`UPDATE support.ticket_attachments SET ticket_id = ${input.survivorId} WHERE ticket_id = ${input.sourceId}`;
      await tx`UPDATE support.tickets SET status = 'closed', updated_at = now() WHERE id = ${input.sourceId}`;
      await tx`UPDATE support.tickets SET updated_at = now() WHERE id = ${input.survivorId}`;
      const [row] = await tx<PgMerge[]>`
        INSERT INTO support.ticket_merges (source_id, survivor_id, actor_id, reason, comments_moved, attachments_moved)
        VALUES (${input.sourceId}, ${input.survivorId}, ${input.operatorId}, ${input.reason}, ${comments.count}, ${files.count})
        RETURNING source_id, survivor_id, actor_id, reason, comments_moved, attachments_moved, merged_at
      `;
      const base = { actorId: input.operatorId, actorRole: 'operator' as const };
      await insertEvent(tx, { ...base, ticketId: input.sourceId, kind: 'merged', note: mergeNote('into', input.survivorId, input.reason) });
      await insertEvent(tx, {
        ...base,
        ticketId: input.sourceId,
        kind: 'status_changed',
        fromStatus: source.status,
        toStatus: 'closed',
        note: 'merged',
      });
      await insertEvent(tx, {
        ...base,
        ticketId: input.survivorId,
        kind: 'merged',
        note: mergeNote('absorbed', input.sourceId, input.reason),
      });
      return { status: 'ok', merge: mergeFromPg(row!), replay: false };
    });
  }

  async setStatus(input: SetStatusInput): Promise<SetStatusResult> {
    return this.sql.begin(async (tx): Promise<SetStatusResult> => {
      const current = await tx<{ status: SupportTicketStatus; category: SupportTicket['category'] }[]>`
        SELECT status, category FROM support.tickets WHERE id = ${input.ticketId} FOR UPDATE
      `;
      const from = current[0]?.status;
      const category = current[0]?.category;
      if (!from || !category) return { status: 'refuse', reason: 'not_found' };
      if (input.expectedSequence !== undefined) {
        // Under the ticket lock taken above: no comment, claim or status move lands between this read and the update.
        const newer = await pgNewerByOthers(tx, input.ticketId, input.expectedSequence, input.operatorId);
        if (newer.length > 0) return { status: 'refuse', reason: 'stale', newer };
      }

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

  async listPublishedKb(options?: { limit?: number; audiences?: readonly SupportKbAudience[] }): Promise<SupportKbArticle[]> {
    // The audience filter and the page are one query, so a hidden article takes no place in a page.
    const audiences = options?.audiences ? [...options.audiences] : null;
    const rows = await this.sql<PgKb[]>`
      SELECT a.id, a.title_key, a.body_key, a.revision, a.published, a.updated_at, v.category, v.tags, v.audience,
             v.title, v.body, v.language, v.section_id
      FROM support.kb_articles AS a
      LEFT JOIN support.kb_article_versions AS v ON v.id = a.id AND v.version = a.revision
      WHERE a.published = true
        AND (${audiences}::text[] IS NULL OR COALESCE(v.audience, 'public') = ANY(${audiences}::text[]))
      ORDER BY a.id
      ${options?.limit === undefined ? this.sql`` : this.sql`LIMIT ${options.limit}`}
    `;
    return rows.map(kbFromPg);
  }

  async getPublishedKb(id: string): Promise<SupportKbArticle | null> {
    const rows = await this.sql<PgKb[]>`
      SELECT a.id, a.title_key, a.body_key, a.revision, a.published, a.updated_at, v.category, v.tags, v.audience,
             v.title, v.body, v.language, v.section_id
      FROM support.kb_articles AS a
      LEFT JOIN support.kb_article_versions AS v ON v.id = a.id AND v.version = a.revision
      WHERE a.id = ${id} AND a.published = true
      LIMIT 1
    `;
    return rows[0] ? kbFromPg(rows[0]) : null;
  }

  async listKbVersions(id: string): Promise<SupportKbArticle[]> {
    const rows = await this.sql<PgKbVersion[]>`
      SELECT id, title_key, body_key, version, category, tags, audience, title, body, language, section_id
      FROM support.kb_article_versions
      WHERE id = ${id} AND NOT draft
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
        const bad = assertPersistable({ id: input.id, titleKey: input.titleKey, bodyKey: input.bodyKey }, input.text);
        if (bad) return bad;
        const topic = topicOn(input);
        const category = topic.category ?? null;
        const tags = topic.tags ? tx.json(topic.tags) : null;
        const text = textColumns(input.text ?? {});
        if (input.text) {
          // The section is read under a share lock in this transaction, so a retire cannot slip in before the version lands.
          const [open] = await tx<{ id: string }[]>`
            SELECT s.id FROM support.kb_sections s JOIN support.kb_categories c ON c.id = s.category_id
            WHERE s.id = ${input.text.sectionId} AND NOT s.retired AND NOT c.retired
            FOR SHARE OF s, c
          `;
          if (!open) return { status: 'refuse', reason: 'section_unknown' };
        }
        // Drafts (SP-kb-01) sit above the head, so a new version takes the number after every row, draft or not.
        const next = await pgNextKbVersion(tx, input.id);
        if (!current) {
          if (input.baseRevision !== 0) return { status: 'refuse', reason: 'revision_stale' };
          const rows = await tx<PgKb[]>`
            INSERT INTO support.kb_articles (id, title_key, body_key, revision, published)
            VALUES (${input.id}, ${input.titleKey}, ${input.bodyKey}, ${next}, true)
            RETURNING id, title_key, body_key, revision, published, updated_at
          `;
          await tx`
            INSERT INTO support.kb_article_versions
              (id, version, title_key, body_key, category, tags, audience, title, body, language, section_id)
            VALUES (
              ${input.id}, ${next}, ${input.titleKey}, ${input.bodyKey}, ${category}, ${tags}, 'public',
              ${text.title}, ${text.body}, ${text.language}, ${text.sectionId}
            )
          `;
          return { status: 'ok', article: toPublicKb({ ...kbFromPg(rows[0]!), ...topic, ...input.text }) };
        }
        if (current.revision !== input.baseRevision) return { status: 'refuse', reason: 'revision_stale' };
        const rows = await tx<PgKb[]>`
          UPDATE support.kb_articles
          SET title_key = ${input.titleKey},
              body_key = ${input.bodyKey},
              revision = ${next},
              published = true,
              updated_at = now()
          WHERE id = ${input.id} AND revision = ${input.baseRevision}
          RETURNING id, title_key, body_key, revision, published, updated_at
        `;
        if (!rows[0]) return { status: 'refuse', reason: 'revision_stale' };
        const bumped = kbFromPg(rows[0]);
        // A new body keeps who may read it; only setKbAudience changes that.
        const heldAudience = await tx<{ audience: SupportKbAudience }[]>`
          SELECT audience FROM support.kb_article_versions WHERE id = ${input.id} AND version = ${input.baseRevision}
        `;
        const audience = heldAudience[0]?.audience ?? 'public';
        await tx`
          INSERT INTO support.kb_article_versions
            (id, version, title_key, body_key, category, tags, audience, title, body, language, section_id)
          VALUES (
            ${input.id}, ${kbVersionOf(bumped)}, ${input.titleKey}, ${input.bodyKey}, ${category}, ${tags}, ${audience},
            ${text.title}, ${text.body}, ${text.language}, ${text.sectionId}
          )
        `;
        return { status: 'ok', article: toPublicKb({ ...bumped, ...topic, audience, ...input.text }) };
      }

      if (!current) return { status: 'refuse', reason: 'invalid' };
      if (current.revision !== input.baseRevision) return { status: 'refuse', reason: 'revision_stale' };
      const prev = await tx<PgVersionCarry[]>`
        SELECT category, tags, audience, title, body, language, section_id
        FROM support.kb_article_versions
        WHERE id = ${input.id} AND version = ${current.revision}
      `;
      const carried = topicOn(prev[0] ?? {});
      const carriedText = textOn(prev[0] ?? {});
      const text = textColumns(carriedText);
      const next = await pgNextKbVersion(tx, input.id);
      const rows = await tx<PgKb[]>`
        UPDATE support.kb_articles
        SET revision = ${next},
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
        INSERT INTO support.kb_article_versions
          (id, version, title_key, body_key, category, tags, audience, title, body, language, section_id)
        VALUES (
          ${input.id},
          ${kbVersionOf(hidden)},
          ${hidden.titleKey},
          ${hidden.bodyKey},
          ${carried.category ?? null},
          ${carried.tags ? tx.json(carried.tags) : null},
          ${prev[0]?.audience ?? 'public'},
          ${text.title}, ${text.body}, ${text.language}, ${text.sectionId}
        )
      `;
      return {
        status: 'ok',
        article: toPublicKb({ ...hidden, ...carried, audience: prev[0]?.audience ?? 'public', ...carriedText }),
      };
    });
  }

  async setKbAudience(input: SetKbAudienceStoreInput): Promise<SetKbAudienceResult> {
    return this.sql.begin(async (tx): Promise<SetKbAudienceResult> => {
      const locked = await tx<PgKb[]>`
        SELECT id, title_key, body_key, revision, published, updated_at
        FROM support.kb_articles
        WHERE id = ${input.id}
        FOR UPDATE
      `;
      if (!locked[0]) return { status: 'refuse', reason: 'invalid' };
      const current = kbFromPg(locked[0]);
      if (current.revision !== input.baseRevision) return { status: 'refuse', reason: 'revision_stale' };
      const prev = await tx<PgVersionCarry[]>`
        SELECT category, tags, audience, title, body, language, section_id
        FROM support.kb_article_versions
        WHERE id = ${input.id} AND version = ${current.revision}
      `;
      const from = prev[0]?.audience ?? 'public';
      const carried = topicOn(prev[0] ?? {});
      const carriedText = textOn(prev[0] ?? {});
      const text = textColumns(carriedText);
      if (from === input.audience)
        return { status: 'ok', article: toPublicKb({ ...current, ...carried, audience: from, ...carriedText }), changed: false };
      const next = await pgNextKbVersion(tx, input.id);
      const rows = await tx<PgKb[]>`
        UPDATE support.kb_articles
        SET revision = ${next},
            updated_at = now()
        WHERE id = ${input.id} AND revision = ${input.baseRevision}
        RETURNING id, title_key, body_key, revision, published, updated_at
      `;
      if (!rows[0]) return { status: 'refuse', reason: 'revision_stale' };
      const bumped = kbFromPg(rows[0]);
      // 0008 refuses a revision change that has no matching version row; the keys and topic are copied unchanged.
      await tx`
        INSERT INTO support.kb_article_versions
          (id, version, title_key, body_key, category, tags, audience, title, body, language, section_id)
        VALUES (
          ${input.id},
          ${kbVersionOf(bumped)},
          ${bumped.titleKey},
          ${bumped.bodyKey},
          ${carried.category ?? null},
          ${carried.tags ? tx.json(carried.tags) : null},
          ${input.audience},
          ${text.title}, ${text.body}, ${text.language}, ${text.sectionId}
        )
      `;
      await tx`
        INSERT INTO support.kb_audience_changes (article_id, from_audience, to_audience, from_revision, to_revision, actor_id)
        VALUES (${input.id}, ${from}, ${input.audience}, ${current.revision ?? 0}, ${kbVersionOf(bumped)}, ${input.actorId})
      `;
      return { status: 'ok', article: toPublicKb({ ...bumped, ...carried, audience: input.audience, ...carriedText }), changed: true };
    });
  }

  async saveKbDraft(input: SaveKbDraftInput): Promise<SaveKbDraftResult> {
    try {
      return await this.sql.begin(async (tx): Promise<SaveKbDraftResult> => {
        // The head row, when there is one, is the article's lock; a draft-only article is held by the version key below.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'support.kb:' + input.id}))`;
        await tx`SELECT id FROM support.kb_articles WHERE id = ${input.id} FOR UPDATE`;
        const next = await pgNextKbVersion(tx, input.id);
        if (input.baseRevision !== next - 1) return { status: 'refuse', reason: 'revision_stale' };
        const [open] = await tx<{ id: string }[]>`
          SELECT s.id FROM support.kb_sections s JOIN support.kb_categories c ON c.id = s.category_id
          WHERE s.id = ${input.sectionId} AND NOT s.retired AND NOT c.retired
          FOR SHARE OF s, c
        `;
        if (!open) return { status: 'refuse', reason: 'section_unknown' };
        const [held] = await tx<{ audience: SupportKbAudience }[]>`
          SELECT v.audience FROM support.kb_articles a
          JOIN support.kb_article_versions v ON v.id = a.id AND v.version = a.revision
          WHERE a.id = ${input.id}
        `;
        const audience = held?.audience ?? 'public';
        const tags = input.tags.length > 0 ? tx.json([...input.tags]) : null;
        const [row] = await tx<{ created_at: Date }[]>`
          INSERT INTO support.kb_article_versions
            (id, version, title_key, body_key, tags, audience, title, body, language, section_id, draft, author_id, template_id)
          VALUES (
            ${input.id}, ${next}, ${SUPPORT_KB_STORED_TITLE_KEY}, ${SUPPORT_KB_STORED_BODY_KEY}, ${tags}, ${audience},
            ${input.title}, ${input.body}, ${input.language}, ${input.sectionId}, true, ${input.authorId}, ${input.templateId}
          )
          RETURNING created_at
        `;
        return {
          status: 'ok',
          draft: {
            id: input.id,
            revision: next,
            authorId: input.authorId,
            templateId: input.templateId,
            title: input.title,
            body: input.body,
            language: input.language,
            sectionId: input.sectionId,
            tags: [...input.tags],
            audience,
            createdAt: toIso(row!.created_at),
          },
        };
      });
    } catch (err) {
      // Two first drafts of one new article race for version 1: the loser read a stale base.
      if ((err as { code?: string }).code === '23505') return { status: 'refuse', reason: 'revision_stale' };
      throw err;
    }
  }

  async getKbDraft(id: string, revision: number): Promise<KbDraft | null> {
    const [row] = await this.sql<PgKbDraft[]>`
      SELECT id, version, author_id, template_id, title, body, language, section_id, tags, audience, created_at
      FROM support.kb_article_versions
      WHERE id = ${id} AND version = ${revision} AND draft
    `;
    return row ? kbDraftFromPg(row) : null;
  }

  async listKbHistory(id: string): Promise<KbHistoryRow[]> {
    const rows = await this.sql<
      {
        version: number;
        draft: boolean;
        author_id: string | null;
        title: string | null;
        audience: SupportKbAudience;
        live: boolean;
        created_at: Date | null;
        source_revision: number | null;
      }[]
    >`
      SELECT v.version, v.draft, v.author_id, v.title, v.audience, v.created_at, v.source_revision,
             COALESCE(a.published AND a.revision = v.version, false) AS live
      FROM support.kb_article_versions v
      LEFT JOIN support.kb_articles a ON a.id = v.id
      WHERE v.id = ${id}
      ORDER BY v.version
    `;
    return rows.map((r) => ({
      revision: Number(r.version),
      draft: r.draft,
      authorId: r.author_id,
      title: r.title,
      audience: r.audience,
      live: r.live,
      createdAt: r.created_at ? toIso(r.created_at) : null,
      sourceRevision: r.source_revision === null ? null : Number(r.source_revision),
    }));
  }

  async publishKbDraft(input: { id: string; revision: number }): Promise<PublishKbDraftResult> {
    try {
      return await this.pgPublishKbDraft(input);
    } catch (err) {
      // Another write took the next version first: the caller re-reads the history to settle or refuse.
      if ((err as { code?: string }).code === '23505') return { status: 'refuse', reason: 'revision_stale' };
      throw err;
    }
  }

  private pgPublishKbDraft(input: { id: string; revision: number }): Promise<PublishKbDraftResult> {
    return this.sql.begin(async (tx): Promise<PublishKbDraftResult> => {
      // An article with only drafts has no head row to lock, so writes to one article take its advisory lock too.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'support.kb:' + input.id}))`;
      const locked = await tx<PgKb[]>`
        SELECT id, title_key, body_key, revision, published, updated_at FROM support.kb_articles WHERE id = ${input.id} FOR UPDATE
      `;
      const [row] = await tx<PgKbDraft[]>`
        SELECT id, version, author_id, template_id, title, body, language, section_id, tags, audience, created_at
        FROM support.kb_article_versions
        WHERE id = ${input.id} AND version = ${input.revision} AND draft
      `;
      if (!row) return { status: 'refuse', reason: 'draft_unknown' };
      const next = await pgNextKbVersion(tx, input.id);
      if (next !== input.revision + 1) return { status: 'refuse', reason: 'revision_stale' };
      const draft = kbDraftFromPg(row);
      const [open] = await tx<{ id: string }[]>`
        SELECT s.id FROM support.kb_sections s JOIN support.kb_categories c ON c.id = s.category_id
        WHERE s.id = ${draft.sectionId} AND NOT s.retired AND NOT c.retired
        FOR SHARE OF s, c
      `;
      if (!open) return { status: 'refuse', reason: 'section_unknown' };
      const tags = draft.tags.length > 0 ? tx.json([...draft.tags]) : null;
      await tx`
        INSERT INTO support.kb_article_versions
          (id, version, title_key, body_key, tags, audience, title, body, language, section_id, author_id, template_id,
           source_revision)
        VALUES (
          ${input.id}, ${next}, ${SUPPORT_KB_STORED_TITLE_KEY}, ${SUPPORT_KB_STORED_BODY_KEY}, ${tags}, ${draft.audience},
          ${draft.title}, ${draft.body}, ${draft.language}, ${draft.sectionId}, ${draft.authorId}, ${draft.templateId},
          ${input.revision}
        )
      `;
      const head = locked[0]
        ? await tx<PgKb[]>`
            UPDATE support.kb_articles
            SET title_key = ${SUPPORT_KB_STORED_TITLE_KEY}, body_key = ${SUPPORT_KB_STORED_BODY_KEY},
                revision = ${next}, published = true, updated_at = now()
            WHERE id = ${input.id}
            RETURNING id, title_key, body_key, revision, published, updated_at
          `
        : await tx<PgKb[]>`
            INSERT INTO support.kb_articles (id, title_key, body_key, revision, published)
            VALUES (${input.id}, ${SUPPORT_KB_STORED_TITLE_KEY}, ${SUPPORT_KB_STORED_BODY_KEY}, ${next}, true)
            RETURNING id, title_key, body_key, revision, published, updated_at
          `;
      return {
        status: 'ok',
        article: toPublicKb({
          ...kbFromPg(head[0]!),
          ...topicOn({ tags: draft.tags }),
          audience: draft.audience,
          title: draft.title,
          body: draft.body,
          language: draft.language,
          sectionId: draft.sectionId,
        }),
      };
    });
  }

  async listKbAudienceChanges(articleId: string): Promise<KbAudienceChange[]> {
    const rows = await this.sql<
      {
        article_id: string;
        from_audience: SupportKbAudience;
        to_audience: SupportKbAudience;
        from_revision: number;
        to_revision: number;
        actor_id: string;
        created_at: Date;
      }[]
    >`
      SELECT article_id, from_audience, to_audience, from_revision, to_revision, actor_id, created_at
      FROM support.kb_audience_changes WHERE article_id = ${articleId} ORDER BY to_revision
    `;
    return rows.map((r) => ({
      articleId: r.article_id,
      fromAudience: r.from_audience,
      toAudience: r.to_audience,
      fromRevision: Number(r.from_revision),
      toRevision: Number(r.to_revision),
      actorId: r.actor_id,
      createdAt: toIso(r.created_at),
    }));
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

  async listRatedTicketIdsFor(userId: string): Promise<string[]> {
    const rows = await this.sql<{ ticket_id: string }[]>`
      SELECT ticket_id FROM support.ticket_ratings WHERE user_id = ${userId}
    `;
    return rows.map((row) => row.ticket_id);
  }

  async listRatings(): Promise<TicketRating[]> {
    const rows = await this.sql<PgRating[]>`
      SELECT ticket_id, user_id, score, note, created_at, client_request_id
      FROM support.ticket_ratings
    `;
    return rows.map(ratingFromPg);
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
    maxCount: number;
    operatorId?: string;
  }): Promise<RecordAttachmentResult> {
    const actor = input.operatorId ?? input.userId;
    return this.sql.begin(async (tx): Promise<RecordAttachmentResult> => {
      const locked = await tx<{ user_id: string; assignee_id: string | null }[]>`
        SELECT user_id, assignee_id FROM support.tickets WHERE id = ${input.ticketId} FOR UPDATE
      `;
      const prior = await tx<{ result: { attachment: AttachmentMeta } }[]>`
        SELECT result FROM support.write_receipts
        WHERE procedure = 'support.attach' AND actor_id = ${actor} AND client_request_id = ${input.clientRequestId}
        LIMIT 1
      `;
      if (prior[0]) {
        // The receipt holds what was first answered; the file's state since is read live.
        const [live] = await tx<PgAttachment[]>`
          SELECT id, ticket_id, owner_id, content_type, byte_length, store_key, scan_state, uploaded_by, created_at
          FROM support.ticket_attachments WHERE id = ${prior[0].result.attachment.id}
        `;
        return { status: 'ok', attachment: live ? attachmentFromPg(live) : prior[0].result.attachment, replay: true };
      }
      if (!locked[0] || locked[0].user_id !== input.userId) return { status: 'refuse', reason: 'not_found' };
      if (input.operatorId !== undefined && locked[0].assignee_id !== input.operatorId) return { status: 'refuse', reason: 'not_found' };
      // The ticket row is locked, so two files racing for the last place cannot both be taken.
      const [held] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM support.ticket_attachments
        WHERE ticket_id = ${input.ticketId} AND scan_state <> 'blocked'
      `;
      if ((held?.n ?? 0) >= input.maxCount) return { status: 'refuse', reason: 'count_reached' };

      const rows = await tx<PgAttachment[]>`
        INSERT INTO support.ticket_attachments (id, ticket_id, owner_id, client_request_id, store_key, content_type, byte_length, scan_state, uploaded_by)
        VALUES (
          ${input.id},
          ${input.ticketId},
          ${input.userId},
          ${input.clientRequestId},
          ${input.storeKey},
          ${input.contentType},
          ${input.byteLength},
          'scanning',
          ${input.operatorId ?? null}
        )
        RETURNING id, ticket_id, owner_id, content_type, byte_length, store_key, scan_state, uploaded_by, created_at
      `;
      const attachment = attachmentFromPg(rows[0]!);
      await tx`
        INSERT INTO support.write_receipts (procedure, actor_id, client_request_id, result)
        VALUES ('support.attach', ${actor}, ${input.clientRequestId}, ${tx.json({ attachment } as never)})
      `;
      return { status: 'ok', attachment, replay: false };
    });
  }

  async readAttachment(input: { userId: string; attachmentId: string; asOperator: boolean }): Promise<ReadAttachmentResult> {
    const rows = await this.sql<(PgAttachment & { assignee_id: string | null })[]>`
      SELECT a.id, a.ticket_id, a.owner_id, a.content_type, a.byte_length, a.store_key, a.scan_state, a.uploaded_by, a.created_at, t.assignee_id
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

  async setAttachmentScanState(input: { attachmentId: string; state: 'clean' | 'blocked' }): Promise<AttachmentMeta | null> {
    // Only a file still scanning moves; the answer for any other is the row as it is.
    await this.sql`
      UPDATE support.ticket_attachments SET scan_state = ${input.state}
      WHERE id = ${input.attachmentId} AND scan_state = 'scanning'
    `;
    const rows = await this.sql<PgAttachment[]>`
      SELECT id, ticket_id, owner_id, content_type, byte_length, store_key, scan_state, uploaded_by, created_at
      FROM support.ticket_attachments WHERE id = ${input.attachmentId}
    `;
    return rows[0] ? attachmentFromPg(rows[0]) : null;
  }

  async listAttachmentsFor(ticketId: string, limit: number): Promise<AttachmentMeta[]> {
    const rows = await this.sql<PgAttachment[]>`
      SELECT id, ticket_id, owner_id, content_type, byte_length, store_key, scan_state, uploaded_by, created_at
      FROM support.ticket_attachments WHERE ticket_id = ${ticketId}
      ORDER BY created_at, id LIMIT ${limit}
    `;
    return rows.map(attachmentFromPg);
  }

  async listScanningAttachments(limit: number): Promise<AttachmentMeta[]> {
    const rows = await this.sql<PgAttachment[]>`
      SELECT id, ticket_id, owner_id, content_type, byte_length, store_key, scan_state, uploaded_by, created_at
      FROM support.ticket_attachments WHERE scan_state = 'scanning'
      ORDER BY created_at, id LIMIT ${limit}
    `;
    return rows.map(attachmentFromPg);
  }

  async recordKbFeedback(input: RecordKbFeedbackInput): Promise<RecordFeedbackResult> {
    return this.sql.begin(async (tx): Promise<RecordFeedbackResult> => {
      const prior = await tx<{ result: RecordFeedbackResult }[]>`
        SELECT result FROM support.write_receipts
        WHERE procedure = 'support.kbFeedback' AND actor_id = ${input.userId} AND client_request_id = ${input.clientRequestId}
        LIMIT 1
      `;
      if (prior[0]) return prior[0].result;

      // One reader at a time, so two votes cannot both pass a rate check.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`support.kbFeedback:${input.userId}`}, 0))`;

      const head = await tx<{ revision: number; published: boolean }[]>`
        SELECT revision, published FROM support.kb_articles WHERE id = ${input.articleId} FOR UPDATE
      `;
      if (!head[0] || head[0].published !== true) return { status: 'refuse', reason: 'not_published' };
      const version = Number(head[0].revision);
      const existing = await tx<{ helpful: boolean; ticket_id: string | null }[]>`
        SELECT helpful, ticket_id FROM support.kb_feedback
        WHERE user_id = ${input.userId} AND article_id = ${input.articleId} AND version = ${version}
        LIMIT 1
      `;
      if (existing[0]) {
        return {
          status: 'ok',
          vote: {
            ...kbFeedbackWire({
              articleId: input.articleId,
              version,
              userId: input.userId,
              helpful: existing[0].helpful,
              ticketId: existing[0].ticket_id,
            }),
            earlier: true,
          },
        };
      }

      const comment = input.comment?.trim() ?? '';
      if (input.openRequest === true && (input.helpful || comment.length === 0 || input.userId.startsWith(READER_ACTOR_PREFIX))) {
        return { status: 'refuse', reason: 'request_invalid' };
      }
      const now = input.now ?? new Date().toISOString();
      if (input.rate === 'unset') return { status: 'refuse', reason: 'rate_unset' };
      if (input.rate) {
        const cutoff = feedbackRateCutoff(now, input.rate.windowSeconds);
        const recent = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM support.kb_feedback
          WHERE user_id = ${input.userId} AND created_at > ${cutoff}::timestamptz
        `;
        if (Number(recent[0]?.n ?? 0) >= input.rate.limit) return { status: 'refuse', reason: 'rate_exceeded' };
      }

      let ticketId: string | undefined;
      if (input.openRequest === true) {
        const copy = feedbackRequestCopy(input.articleId, version, comment);
        const ticket = await insertTicketWithOpened(tx, {
          userId: input.userId,
          category: 'other',
          subject: copy.subject,
          body: copy.body,
        });
        ticketId = ticket.id;
      }
      await tx`
        INSERT INTO support.kb_feedback (article_id, version, user_id, helpful, client_request_id, comment, ticket_id, created_at)
        VALUES (
          ${input.articleId},
          ${version},
          ${input.userId},
          ${input.helpful},
          ${input.clientRequestId},
          ${comment || null},
          ${ticketId ?? null},
          ${now}::timestamptz
        )
      `;
      const ok: RecordFeedbackResult = {
        status: 'ok',
        vote: kbFeedbackWire({
          articleId: input.articleId,
          version,
          userId: input.userId,
          helpful: input.helpful,
          ticketId,
        }),
      };
      await tx`
        INSERT INTO support.write_receipts (procedure, actor_id, client_request_id, result)
        VALUES ('support.kbFeedback', ${input.userId}, ${input.clientRequestId}, ${tx.json(ok as never)})
      `;
      return ok;
    });
  }

  async listKbFeedbackSummary(limit: number): Promise<KbFeedbackCount[]> {
    const rows = await this.sql<{ article_id: string; version: number; helpful: number; unhelpful: number }[]>`
      SELECT article_id, version,
        count(*) FILTER (WHERE helpful)::int AS helpful,
        count(*) FILTER (WHERE NOT helpful)::int AS unhelpful
      FROM support.kb_feedback
      GROUP BY article_id, version
      ORDER BY article_id, version
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      articleId: row.article_id,
      version: Number(row.version),
      helpful: Number(row.helpful),
      unhelpful: Number(row.unhelpful),
    }));
  }

  async recordSearchMiss(input: { query: string; at: string }): Promise<void> {
    await this.sql`
      INSERT INTO support.kb_search_misses (query, result_count, created_at)
      VALUES (${input.query}, 0, ${input.at}::timestamptz)
    `;
  }

  async listSearchMisses(limit: number): Promise<KbSearchMiss[]> {
    const rows = await this.sql<{ query: string; created_at: Date }[]>`
      SELECT query, created_at FROM support.kb_search_misses
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({ query: row.query, at: toIso(row.created_at), resultCount: 0 as const }));
  }

  async hasSearchClick(clientRequestId: string): Promise<boolean> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT 1 AS n FROM support.kb_search_clicks WHERE client_request_id = ${clientRequestId} LIMIT 1
    `;
    return rows.length > 0;
  }

  async recordSearchClick(input: { query: string; articleId: string; clientRequestId: string; at: string }): Promise<void> {
    await this.sql`
      INSERT INTO support.kb_search_clicks (query, article_id, client_request_id, created_at)
      VALUES (${input.query}, ${input.articleId}, ${input.clientRequestId}, ${input.at}::timestamptz)
      ON CONFLICT (client_request_id) DO NOTHING
    `;
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
  scan_state: AttachmentScanState;
  uploaded_by: string | null;
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
    scanState: row.scan_state,
    uploadedBy: row.uploaded_by,
    createdAt: toIso(row.created_at),
  };
}
