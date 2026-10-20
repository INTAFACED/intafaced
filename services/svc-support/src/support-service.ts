import { randomUUID } from 'node:crypto';
import { AuthError, requireScope, type Principal } from '@intafaced/auth';
import {
  SUPPORT_ATTACHMENT_DOWNLOAD_TYPE,
  SUPPORT_ATTACHMENT_KEYS,
  SUPPORT_KB_AUDIENCES,
  SUPPORT_LABELS_MAX,
  kbAudienceVisibleTo,
  supportLabelSchema,
  supportTicketPrioritySchema,
  supportTicketTypeSchema,
  type SupportAttachmentDownload,
  type SupportAttachmentKey,
  type SupportAttachmentLimits,
  type SupportAttachmentStatus,
  type SupportTicketPriority,
  type SupportAwaitingMine,
  type SupportTicketLifecycle,
  type SupportTicketProperties,
  type SupportTicketType,
} from '@intafaced/contracts';
import type {
  CreateTicketInput,
  EscalateTicketInput,
  SupportAccountGrounding,
  SupportCaseFile,
  SupportCitation,
  SupportComment,
  SupportContract,
  SupportKbArticle,
  SupportKbAudience,
  SupportKbViewer,
  SupportTicket,
  SupportTicketEvent,
  SupportTicketStatus,
} from '@intafaced/contracts';
import { DarkAccountState, type AccountStateSource } from './account-state.js';
import {
  MemoryStaffBook,
  STAFF_AVAILABILITIES,
  type StaffAvailability,
  type StaffBook,
  type StaffMember,
  type StaffRole,
} from './desk-staff.js';
import { IDENTITY_GROUNDING_UNWIRED, IdentityGroundingUnwiredError } from './identity-grounding-honesty.js';
import { buildCaseFile, citeAccountState, citeComment, citeKbArticle, groundingFor } from './case-file.js';
import {
  ATTACHMENT_MAX_COUNT_KEY,
  UNCONFIGURED_ATTACHMENTS,
  decodeAttachmentBody,
  missingAttachmentKey,
  type AttachmentDesk,
  type ScanVerdict,
} from './attachments.js';
import { MemoryAttachmentSettingsBook, type AttachmentSettingsBook } from './attachment-settings.js';
import { assertKbArticle, assertKbTopic, getKb, KbCatalogError, relatedPublished, searchKb, toPublicKb } from './kb-catalog.js';
import { isTerminal } from './lifecycle.js';
import {
  OperatorQueueLimitUnsetError,
  QUEUE_LIST_LIMIT_UNSET,
  assertOperatorQueueLimit as publishedOperatorQueueLimit,
  assignNext,
  buildOperatorQueue,
  type QueueEntry,
  type QueueResult,
} from './operator-queue.js';
import { SUPPORT_SETTLE_REFUSE, checkSupportSettlement, type SupportForbiddenSettlementAct } from './settlement-refuse.js';
import { MemorySupportStore, type AttachmentMeta, type KbFeedbackVote, type SupportStore, type TicketRating } from './store.js';
import {
  DarkTicketOrderSource,
  SUPPORT_ORDER_USER_MISMATCH,
  supportOrderSnapshotSchema,
  type TicketOrderRead,
  type TicketOrderSource,
} from './ticket-order.js';
import { MemoryLifecycleBook, type LifecycleBook } from './ticket-lifecycle.js';
import { MemoryRatingRequestBook, RatingRequestOutbox } from './rating-request.js';
import { MemoryPropertiesBook, normaliseLabels, type PropertiesBook } from './desk-properties.js';
import { MemoryGroupBook, deskCanSee, type DeskGroup, type DeskViewer, type GroupBook } from './desk-groups.js';
import { withSupportSpan } from './tracing.js';

const INVALID = Symbol('invalid');

/** undefined stays undefined, null stays null, a known value passes, anything else is INVALID. */
function parseEnumField<T extends string>(
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  value: string | null | undefined,
): T | null | undefined | typeof INVALID {
  if (value === undefined || value === null) return value;
  const parsed = schema.safeParse(value);
  return parsed.success ? (parsed.data as T) : INVALID;
}

const scanRefused = (): SupportError => new SupportError('attachment did not pass the scanner', 'support.attachment_scan_refused');

export class SupportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly missingKey?: string,
  ) {
    super(message);
    this.name = 'SupportError';
  }
}

/**
 * The single refusal for "you may not see this ticket", whatever the reason.
 *
 * Carries NO ticket id. `mapError` puts i18n `userCopy(err.code)` on the wire, so
 * an id echoed back is an id confirmed to exist — and the point of answering a
 * foreign ticket with `not_found` rather than a forbidden is that the caller
 * cannot tell the two apart. One construction site, so they cannot drift again.
 */
function ticketNotFound(): SupportError {
  return new SupportError('ticket not found', 'support.not_found');
}

/** Owner-published listQueue page size. Blank is not 100. */
export function assertOperatorQueueLimit(limit: number | undefined): number {
  try {
    return publishedOperatorQueueLimit(limit);
  } catch (err) {
    if (err instanceof OperatorQueueLimitUnsetError) {
      throw new SupportError('operator queue list limit unset', QUEUE_LIST_LIMIT_UNSET);
    }
    throw err;
  }
}

/** listAll page size unpublished. Blank is not 100. */
export const LIST_ALL_LIMIT_UNSET = 'support.list_all_limit_unset' as const;

/** Existing support ops list door max (listQueue) — not a newly invented default. */
export const LIST_ALL_LIMIT_MAX = 500;

/** Owner-published listAll page size. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertListAllTicketsLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new SupportError('operator listAll limit unset', LIST_ALL_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new SupportError('operator listAll limit unset', LIST_ALL_LIMIT_UNSET);
  }
  return Math.min(LIST_ALL_LIMIT_MAX, n);
}

/** listMine page size unpublished. Blank is not 100. */
export const LIST_MINE_LIMIT_UNSET = 'support.list_mine_limit_unset' as const;

/** Existing support list door max (listQueue / listAll) — not a newly invented default. */
export const LIST_MINE_LIMIT_MAX = LIST_ALL_LIMIT_MAX;

/** Owner-published listMine page size. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertListMineTicketsLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new SupportError('listMine limit unset', LIST_MINE_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new SupportError('listMine limit unset', LIST_MINE_LIMIT_UNSET);
  }
  return Math.min(LIST_MINE_LIMIT_MAX, n);
}

/** listComments page size unpublished. Blank is not 100. */
export const LIST_COMMENTS_LIMIT_UNSET = 'support.list_comments_limit_unset' as const;

/** Existing support list door max (listQueue / listAll / listMine) — not a newly invented default. */
export const LIST_COMMENTS_LIMIT_MAX = LIST_ALL_LIMIT_MAX;

/** Owner-published listComments page size. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertListCommentsLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new SupportError('listComments limit unset', LIST_COMMENTS_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new SupportError('listComments limit unset', LIST_COMMENTS_LIMIT_UNSET);
  }
  return Math.min(LIST_COMMENTS_LIMIT_MAX, n);
}

/** ticketAttachments page size unpublished. Blank is not 100. */
export const LIST_ATTACHMENTS_LIMIT_UNSET = 'support.list_attachments_limit_unset' as const;

/** Owner-published ticketAttachments page size. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertListAttachmentsLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit) || Math.floor(limit) < 1) {
    throw new SupportError('ticketAttachments limit unset', LIST_ATTACHMENTS_LIMIT_UNSET);
  }
  return Math.min(LIST_COMMENTS_LIMIT_MAX, Math.floor(limit));
}

/** events / listTicketEvents page size unpublished. Blank is not 100. */
export const LIST_EVENTS_LIMIT_UNSET = 'support.list_events_limit_unset' as const;

/** Existing support list door max (listQueue / listAll / listMine / listComments) — not a newly invented default. */
export const LIST_EVENTS_LIMIT_MAX = LIST_ALL_LIMIT_MAX;

/** Owner-published events page size. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertListEventsLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new SupportError('listTicketEvents limit unset', LIST_EVENTS_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new SupportError('listTicketEvents limit unset', LIST_EVENTS_LIMIT_UNSET);
  }
  return Math.min(LIST_EVENTS_LIMIT_MAX, n);
}

/** setKbAudience got something outside public, signed_in and staff. */
export const KB_AUDIENCE_INVALID = 'support.kb_audience_invalid' as const;

/** The reader of a public help door when the caller did not say: a signed-out visitor sees public articles only. */
const ANONYMOUS_KB_VIEWER: SupportKbViewer = { signedIn: false, staff: false };

/** The audiences a reader may see: public always, signed_in once signed in, staff for the desk. */
function audiencesFor(viewer: SupportKbViewer): SupportKbAudience[] {
  return SUPPORT_KB_AUDIENCES.filter((audience) => kbAudienceVisibleTo(audience, viewer));
}

/** listKb page size unpublished. Blank is not 100. */
export const LIST_KB_LIMIT_UNSET = 'support.list_kb_limit_unset' as const;

/** Existing support list door max (listQueue / listAll / listMine / listComments) — not a newly invented default. */
export const LIST_KB_LIMIT_MAX = LIST_ALL_LIMIT_MAX;

/** Owner-published listKb page size. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertListKbLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new SupportError('listKb limit unset', LIST_KB_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new SupportError('listKb limit unset', LIST_KB_LIMIT_UNSET);
  }
  return Math.min(LIST_KB_LIMIT_MAX, n);
}

/**
 * Support desk — tickets + KB + operator queue.
 * Zero money: no ledger client, no balance fields on tickets.
 *
 * Store defaults to memory for tests; production injects PostgresSupportStore
 * so multi-replica claims stay exclusive.
 */
export class SupportService implements SupportContract {
  constructor(
    private readonly store: SupportStore = new MemorySupportStore(),
    /**
     * Where account state is READ from. Defaults dark, so a service booted
     * without svc-identity reports "not read" rather than nothing at all.
     */
    private readonly accounts: AccountStateSource = new DarkAccountState(),
    /** Production leaves this blank. Attach then refuses with the missing key. */
    private readonly attachments: AttachmentDesk = UNCONFIGURED_ATTACHMENTS,
    private readonly staff: StaffBook = new MemoryStaffBook(),
    /**
     * Where one order is READ from. Defaults dark, so a desk booted without
     * svc-trade says the read is unknown rather than cancelled.
     */
    private readonly orders: TicketOrderSource = new DarkTicketOrderSource(),
    /**
     * Seconds without a heartbeat before an online or busy agent reads as
     * offline. Blank (null) is an owner value left unset: availability stays
     * as last set and the desk says automatic offline is not set.
     */
    private readonly heartbeatWindowSeconds: number | null = null,
    private readonly now: () => Date = () => new Date(),
    /** Desk groups. While none exist every support:ops caller sees the whole queue. */
    private readonly groups: GroupBook = new MemoryGroupBook(),
    /** Roles the owner marked as seeing every group. Blank (empty) marks none. */
    private readonly allGroupsRoles: readonly StaffRole[] = [],
    /** Agent-set priority, type and labels, kept beside the ticket (operator-only). */
    private readonly properties: PropertiesBook = new MemoryPropertiesBook(),
    /** Who a ticket waits on, the first public reply and the follow-up link, kept beside the ticket. */
    private readonly lifecycle: LifecycleBook = new MemoryLifecycleBook(),
    /** The ask to rate a resolved request, recorded once per ticket and published to the bus. */
    private readonly ratingRequests: RatingRequestOutbox = new RatingRequestOutbox(new MemoryRatingRequestBook(), async () => null),
    /** The owner's size, type and count limits for an attachment. Blank until set; the deployment desk's own values win. */
    private readonly attachmentSettings: AttachmentSettingsBook = new MemoryAttachmentSettingsBook(),
  ) {}

  /** The viewer's place in the desk, or null while no group exists (visibility not restricted). */
  private async deskScope(viewerId: string): Promise<{ viewer: DeskViewer; grouped: Map<string, string> } | null> {
    if ((await this.groups.list()).length === 0) return null;
    const member = await this.staff.get(viewerId);
    return {
      viewer: { userId: viewerId, role: member?.role ?? null, groupIds: await this.groups.groupsOfUser(viewerId) },
      grouped: await this.groups.groupedTickets(),
    };
  }

  private async visibleTickets(viewerId: string | undefined, tickets: SupportTicket[]): Promise<SupportTicket[]> {
    if (viewerId === undefined) return tickets;
    const scope = await this.deskScope(viewerId);
    if (!scope) return tickets;
    return tickets.filter((t) => deskCanSee(scope.viewer, t, scope.grouped.get(t.id) ?? null, this.allGroupsRoles));
  }

  /** A ticket outside the viewer's scope answers exactly like no such ticket. */
  async assertDeskVisible(viewerId: string, ticketId: string, hidden: () => Error = ticketNotFound): Promise<void> {
    const ticket = await this.store.findById(ticketId);
    // A missing ticket is left to the caller's own not-found; only a hidden one is answered here.
    if (ticket && (await this.visibleTickets(viewerId, [ticket])).length === 0) throw hidden();
  }

  /** What the queue header says: whether scope is restricted and which groups the viewer is in. */
  async deskScopeSummary(viewerId: string): Promise<{
    restricted: boolean;
    groups: { id: string; name: string }[];
    seesAllGroups: boolean;
  }> {
    const all = await this.groups.list();
    if (all.length === 0) return { restricted: false, groups: [], seesAllGroups: true };
    const member = await this.staff.get(viewerId);
    const seesAllGroups = member !== null && this.allGroupsRoles.includes(member.role);
    const mine = new Set(await this.groups.groupsOfUser(viewerId));
    return {
      restricted: true,
      groups: all.filter((g) => seesAllGroups || mine.has(g.id)).map((g) => ({ id: g.id, name: g.name })),
      seesAllGroups,
    };
  }

  async listGroups(): Promise<DeskGroup[]> {
    return this.groups.list();
  }

  private async requireLead(actorId: string): Promise<void> {
    const actor = await this.staff.get(actorId);
    if (actor?.role !== 'lead') throw new SupportError('only a lead can change desk groups', 'support.not_lead');
  }

  /** Creates a group (no groupId) or renames one. A replay of the same key returns the first answer. */
  async saveGroup(input: { actorId: string; groupId?: string; name: string; idempotencyKey: string }): Promise<DeskGroup> {
    // Authority is checked before the key is begun, so a refusal leaves the key free to retry.
    await this.requireLead(input.actorId);
    return this.withIdempotency(`group.save:${input.idempotencyKey}`, `${input.actorId}:${input.groupId ?? ''}:${input.name}`, async () => {
      try {
        const saved = await this.groups.save({
          id: input.groupId,
          name: input.name.trim(),
          by: input.actorId,
          at: this.now().toISOString(),
        });
        if (!saved) throw new SupportError('no such group', 'support.group_unknown');
        return saved;
      } catch (err) {
        if (err instanceof Error && err.message === 'support.group_name_taken') {
          throw new SupportError('a group with that name exists', 'support.group_name_taken');
        }
        throw err;
      }
    });
  }

  async addGroupMember(input: { actorId: string; groupId: string; userId: string }): Promise<DeskGroup> {
    await this.requireLead(input.actorId);
    if (!(await this.staff.get(input.userId))) throw new SupportError('that person is not on the desk staff', 'support.not_staff');
    const result = await this.groups.addMember({ ...input, by: input.actorId, at: this.now().toISOString() });
    if (result === 'unknown_group') throw new SupportError('no such group', 'support.group_unknown');
    if (result === 'duplicate') throw new SupportError('already a member of that group', 'support.group_member_duplicate');
    return (await this.groups.get(input.groupId))!;
  }

  async removeGroupMember(input: { actorId: string; groupId: string; userId: string }): Promise<DeskGroup> {
    await this.requireLead(input.actorId);
    const result = await this.groups.removeMember({ ...input, by: input.actorId, at: this.now().toISOString() });
    if (result === 'unknown_group') throw new SupportError('no such group', 'support.group_unknown');
    return (await this.groups.get(input.groupId))!;
  }

  /** A lead places a ticket in a group, or takes it out (groupId null). */
  async setTicketGroup(input: {
    actorId: string;
    ticketId: string;
    groupId: string | null;
  }): Promise<{ ticketId: string; groupId: string | null }> {
    await this.requireLead(input.actorId);
    // A lead cannot move a ticket they cannot see into their own group to gain sight of it.
    await this.assertDeskVisible(input.actorId, input.ticketId);
    if (!(await this.store.findById(input.ticketId))) throw ticketNotFound();
    const result = await this.groups.setTicketGroup({ ...input, by: input.actorId, at: this.now().toISOString() });
    if (result === 'unknown_group') throw new SupportError('no such group', 'support.group_unknown');
    return { ticketId: input.ticketId, groupId: input.groupId };
  }

  private async withIdempotency<T>(key: string, fingerprint: string, run: () => Promise<T>): Promise<T> {
    let phase: 'new' | 'replay';
    try {
      phase = await this.staff.begin(key, fingerprint);
    } catch (err) {
      if (err instanceof Error && err.message === 'support.idempotency_conflict') {
        throw new SupportError('idempotency key was already used for a different command', 'support.idempotency_conflict');
      }
      throw err;
    }
    if (phase === 'replay') {
      const prior = await this.staff.read<T>(key);
      if (!prior) throw new SupportError('that command is still in progress', 'support.idempotency_conflict');
      return prior;
    }
    const value = await run();
    await this.staff.save(key, value);
    return value;
  }

  async createTicket(input: { userId: string } & CreateTicketInput): Promise<SupportTicket> {
    return withSupportSpan('support.createTicket', { op: 'createTicket' }, async (span) => {
      if (input.messageHeaders !== undefined && input.category !== 'phishing') {
        throw new SupportError('message headers belong to a phishing report only', 'support.headers_not_allowed');
      }
      if (input.followsTicketId !== undefined) {
        // Only the caller's own closed request can be followed. Anyone else's reads the same as none.
        const followed = await this.store.findById(input.followsTicketId);
        if (!followed || followed.userId !== input.userId || followed.status !== 'closed') {
          throw new SupportError('a follow-up needs one of your own closed requests', 'support.follow_up_invalid');
        }
      }
      const row = {
        userId: input.userId,
        category: input.category,
        subject: input.subject,
        body: input.body,
        ...(input.messageHeaders !== undefined ? { messageHeaders: input.messageHeaders } : {}),
      };
      let ticket: SupportTicket;
      try {
        ticket =
          input.clientRequestId !== undefined
            ? await this.store.createTicketOnce({ ...row, clientRequestId: input.clientRequestId })
            : await this.store.createTicket(row);
      } catch (err) {
        if (err instanceof Error && err.message === 'support.idempotency_conflict') {
          throw new SupportError('idempotency key was already used for a different request', 'support.idempotency_conflict');
        }
        throw err;
      }
      if (input.followsTicketId !== undefined) {
        await this.lifecycle.linkFollowUp(ticket.id, input.followsTicketId, ticket.createdAt);
      }
      span.setAttribute('intafaced.support.ticket_id', ticket.id);
      return ticket;
    });
  }

  async listMyTickets(input: { userId: string; limit?: number }): Promise<SupportTicket[]> {
    return withSupportSpan('support.listMyTickets', { op: 'listMyTickets' }, async () => {
      const limit = assertListMineTicketsLimit(input.limit);
      return this.store.listByUser(input.userId, { limit });
    });
  }

  /**
   * How many of the caller's own requests wait on them, and which has waited longest. A count and one pointer, not a list,
   * so it needs no page size; the ticket itself never carries who it waits on. Finished requests wait on nobody.
   */
  async awaitingMine(input: { userId: string }): Promise<SupportAwaitingMine> {
    return withSupportSpan('support.awaitingMine', { op: 'awaitingMine' }, async () => {
      const waiting = await this.lifecycle.awaitingCustomer(await this.store.openIdsByUser(input.userId));
      const first = waiting[0];
      return { count: waiting.length, longestWaiting: first ? { ticketId: first.ticketId, since: first.since } : null };
    });
  }

  async listAllTickets(options: { limit?: number } = {}): Promise<SupportTicket[]> {
    return withSupportSpan('support.listAllTickets', { op: 'listAllTickets' }, async () => {
      const limit = assertListAllTicketsLimit(options.limit);
      return this.store.listAll({ limit });
    });
  }

  /**
   * A ticket, for its owner — or for an operator.
   *
   * SOMEBODY ELSE'S TICKET AND NO SUCH TICKET ARE THE SAME ANSWER.
   */
  async getTicket(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<SupportTicket> {
    return withSupportSpan('support.getTicket', { op: 'getTicket', ticketId: input.ticketId }, async () => {
      const ticket = await this.store.findById(input.ticketId);
      const visible = ticket !== null && (input.asOperator === true || ticket.userId === input.userId);
      if (!visible) throw ticketNotFound();
      // An operator reads their own tickets as a customer; anything else obeys desk scope.
      if (input.asOperator === true && ticket.userId !== input.userId) await this.assertDeskVisible(input.userId, ticket.id);
      return ticket;
    });
  }

  /**
   * Add a comment. Visibility is the same as `getTicket`.
   *
   * A USER reply on `resolved` reopens the same ticket (`resolved → open`) and
   * clears the assignee so the row returns to the shared queue — that is the
   * lifecycle edge already named "a user saying not fixed". An operator note
   * on `resolved` does not reopen (they are not the user).
   *
   * A user comment on `closed` is refused (`support.comment.terminal`). Closed
   * is finished; storing a reply nobody will queue is a ghost. Operators may
   * still annotate a closed ticket.
   */
  async comment(input: { userId: string; ticketId: string; body: string; asOperator?: boolean }): Promise<SupportComment> {
    return withSupportSpan('support.comment', { op: 'comment', ticketId: input.ticketId }, async () => {
      await this.getTicket({
        userId: input.userId,
        ticketId: input.ticketId,
        asOperator: input.asOperator,
      });
      const result = await this.store.addComment({
        ticketId: input.ticketId,
        authorId: input.userId,
        authorRole: input.asOperator ? 'operator' : 'user',
        body: input.body,
      });
      if (result.status === 'refuse') {
        if (result.reason === 'not_found') throw ticketNotFound();
        throw new SupportError('comment refused: ticket is terminal', 'support.comment.terminal');
      }
      // Every operator comment is visible to the customer (there are no internal notes), so each is a public reply:
      // the ticket now waits on the customer and the first one is stamped once. A customer reply puts it back on the team.
      const at = result.comment.createdAt;
      if (input.asOperator) {
        await this.lifecycle.setWaiting(input.ticketId, 'customer', at);
        await this.lifecycle.markFirstPublicReply(input.ticketId, at);
      } else {
        await this.lifecycle.setWaiting(input.ticketId, 'team', at);
      }
      return result.comment;
    });
  }

  async listComments(input: { userId: string; ticketId: string; asOperator?: boolean; limit?: number }): Promise<SupportComment[]> {
    return withSupportSpan('support.listComments', { op: 'listComments', ticketId: input.ticketId }, async () => {
      const limit = assertListCommentsLimit(input.limit);
      await this.getTicket({
        userId: input.userId,
        ticketId: input.ticketId,
        asOperator: input.asOperator,
      });
      return this.store.listComments(input.ticketId, { limit });
    });
  }

  /**
   * Move a ticket through its lifecycle, recording who moved it and from what.
   *
   * Refusals:
   *
   *   · `support.not_found` — no such ticket. Unchanged.
   *   · `support.settle.refused` — resolve/close that implies a payout, or a
   *     note claiming the money moved / the freeze lifted. Decided inside
   *     `store.setStatus` after the ticket row lock, from the category, the
   *     note, and every case-file reason. `latestCaseFile` is not the
   *     authority. The desk cites; it does not settle. No ledger entry.
   *   · `support.transition_illegal` — `closed` is terminal, so a finished
   *     complaint cannot be silently re-opened. `resolved → open` IS legal;
   *     that is the reopen path and it is recorded like anything else.
   *   · `support.transition_same_status` — resolving an already-resolved ticket
   *     is refused rather than writing a trail row that records no change. A
   *     history of `open → open` is a history nobody reads.
   */
  async setStatus(input: { operatorId: string; ticketId: string; status: SupportTicketStatus; note?: string }): Promise<SupportTicket> {
    return withSupportSpan('support.setStatus', { op: 'setStatus', ticketId: input.ticketId }, async (span) => {
      await this.assertDeskVisible(input.operatorId, input.ticketId);
      if (input.status === 'on_hold' && !input.note?.trim()) {
        throw new SupportError('say why the request is on hold', 'support.hold_reason_required');
      }
      // The store re-reads the ticket and every case-file reason under its
      // row lock. A latestCaseFile read here would miss a money_request that
      // a later file hides, or one that commits before the lock.
      const result = await this.store.setStatus({
        ticketId: input.ticketId,
        status: input.status,
        operatorId: input.operatorId,
        note: input.note ?? null,
      });
      if (result.status === 'refuse') {
        if (result.reason === 'not_found') throw ticketNotFound();
        if (result.reason === 'settle') throw new SupportError('support cannot settle', SUPPORT_SETTLE_REFUSE);
        throw new SupportError(
          `status change refused: ${result.reason}`,
          `support.transition_${result.reason === 'same_status' ? 'same_status' : 'illegal'}`,
        );
      }
      span.setAttribute('intafaced.support.ticket_id', result.ticket.id);
      span.setAttribute('intafaced.support.to_status', result.ticket.status);
      // Finished requests wait on nobody.
      if (result.ticket.status === 'resolved' || result.ticket.status === 'closed') {
        await this.lifecycle.setWaiting(result.ticket.id, null, result.ticket.updatedAt);
      }
      if (result.ticket.status === 'resolved') {
        // Never fails or waits on the status change: the ask is a row first and a message second.
        void this.ratingRequests
          .record({ ticketId: result.ticket.id, userId: result.ticket.userId, resolvedAt: result.ticket.updatedAt })
          .then(() => this.ratingRequests.flush())
          .catch(() => undefined);
      }
      return result.ticket;
    });
  }

  /**
   * Complete a withdrawal, unfreeze an account, or move money — always refused.
   * Named door so a compromised support channel cannot settle by calling a tool.
   */
  async attemptSettlement(input: { operatorId: string; act: SupportForbiddenSettlementAct; ticketId?: string }): Promise<never> {
    return withSupportSpan('support.attemptSettlement', { op: 'attemptSettlement', ticketId: input.ticketId }, async () => {
      void input.operatorId;
      const settle = checkSupportSettlement({ act: input.act });
      throw new SupportError('support cannot settle', settle.status === 'refuse' ? settle.code : SUPPORT_SETTLE_REFUSE);
    });
  }

  /** The audit trail. Owner sees their own ticket's; operators see any. */
  async listTicketEvents(input: { userId: string; ticketId: string; asOperator?: boolean; limit?: number }): Promise<SupportTicketEvent[]> {
    return withSupportSpan('support.listTicketEvents', { op: 'listTicketEvents', ticketId: input.ticketId }, async () => {
      const limit = assertListEventsLimit(input.limit);
      // Visibility is decided by getTicket, which answers "somebody else's" and
      // "no such thing" identically — so the trail cannot be used to probe for
      // ticket ids the caller may not see.
      await this.getTicket(input);
      return this.store.listEvents(input.ticketId, { limit });
    });
  }

  /**
   * READ THE TICKET OWNER'S ACCOUNT STATE — and record that it was read.
   *
   * Note what this method does NOT take: a `userId`. An operator reads the
   * account state OF A TICKET they are working, and the user id comes off the
   * ticket row rather than off the request. That closes the surface that would
   * otherwise exist — `support:ops` plus a user id is an account-lookup API for
   * the whole platform, which is an authority the scope was never granted and
   * which no ticket needs. It is the same bound svc-agents' support agent
   * already refuses on (`account_owner_mismatch`).
   *
   * A dark or unreachable identity plane returns `{ status: 'unread' }`, never
   * an invented `active`.
   */
  async readAccountState(input: { operatorId: string; ticketId: string }): Promise<SupportAccountGrounding> {
    return withSupportSpan('support.readAccountState', { op: 'readAccountState' }, async (span) => {
      await this.assertDeskVisible(input.operatorId, input.ticketId);
      const ticket = await this.store.findById(input.ticketId);
      if (!ticket) throw ticketNotFound();

      let state;
      try {
        state = await this.accounts.stateOf(ticket.userId);
      } catch (err) {
        // Unwired secret is not plane_dark — name the refuse, do not record unread.
        if (err instanceof IdentityGroundingUnwiredError) {
          throw new SupportError(err.message, IDENTITY_GROUNDING_UNWIRED);
        }
        throw err;
      }
      const grounding = groundingFor(state, new Date().toISOString());

      span.setAttribute('intafaced.support.ticket_id', ticket.id);
      span.setAttribute('intafaced.support.grounding', grounding.status);

      // The read is itself an auditable act: "who looked at whose account, and
      // when" is the question `svc-p2p.instrument_access_log` exists to answer,
      // and a support desk needs it for the same reason.
      await this.store.appendEvent({
        ticketId: ticket.id,
        kind: 'grounding_read',
        actorId: input.operatorId,
        actorRole: 'operator',
        note: grounding.status === 'read' ? `account_state:${grounding.state.status}` : `unread:${grounding.reason}`,
      });

      return grounding;
    });
  }

  /**
   * READ ONE ORDER FOR THIS TICKET.
   *
   * The user id comes off the ticket. An order owned by someone else is
   * refused and its fields are not returned. Trade silence and a matcher
   * that is down are `unknown` with `cancelled: false`. This method only
   * calls `orders.read`. It has no ledger client and no cancel, amend, or
   * delete.
   */
  async readTicketOrder(input: { operatorId: string; ticketId: string; orderId: string }): Promise<TicketOrderRead> {
    return withSupportSpan('support.readTicketOrder', { op: 'readTicketOrder' }, async (span) => {
      await this.assertDeskVisible(input.operatorId, input.ticketId);
      const ticket = await this.store.findById(input.ticketId);
      if (!ticket) throw ticketNotFound();

      span.setAttribute('intafaced.support.ticket_id', ticket.id);
      const result = await this.orders.read(input.orderId);
      if (result.kind === 'unknown') {
        span.setAttribute('intafaced.support.order_read', 'unknown');
        return { outcome: 'unknown', orderId: input.orderId, reason: result.reason, cancelled: false };
      }

      const parsed = supportOrderSnapshotSchema.safeParse(result.order);
      if (!parsed.success || parsed.data.orderId !== input.orderId) {
        span.setAttribute('intafaced.support.order_read', 'unknown');
        return { outcome: 'unknown', orderId: input.orderId, reason: 'trade_silent', cancelled: false };
      }
      if (parsed.data.userId !== ticket.userId) {
        span.setAttribute('intafaced.support.order_read', 'user_mismatch');
        throw new SupportError('order user is not the ticket user', SUPPORT_ORDER_USER_MISMATCH);
      }

      span.setAttribute('intafaced.support.order_read', parsed.data.status);
      return {
        outcome: 'read',
        orderId: parsed.data.orderId,
        status: parsed.data.status,
        symbol: parsed.data.symbol,
        side: parsed.data.side,
        filledQuantity: parsed.data.filledQuantity,
        feeAsset: parsed.data.feeAsset,
        feeAmount: parsed.data.feeAmount,
      };
    });
  }

  /**
   * ESCALATE WITH A CASE FILE.
   *
   * The case file is assembled HERE, from what the desk can actually verify,
   * rather than from anything the operator types. The operator supplies a
   * summary, a reason and the ids of KB articles they relied on; this method
   * resolves those ids against the real catalog, reads the account state, reads
   * the ticket's comments, and digests each one. An article id that does not
   * exist contributes no citation — so an escalation cannot be made to look
   * grounded by citing something that was never there.
   *
   * MOVES NO VALUE. `reason: 'money_request'` records that a user asked for one;
   * there is no amount to attach and no ledger client in this service to attach
   * it to. The request leaves the desk as a named reason and the pay/ledger
   * recipe that owns the money is reached through its own path (§0.6).
   */
  async escalate(input: { operatorId: string } & EscalateTicketInput): Promise<SupportCaseFile> {
    return withSupportSpan('support.escalate', { op: 'escalate' }, async (span) => {
      await this.assertDeskVisible(input.operatorId, input.ticketId);
      const ticket = await this.store.findById(input.ticketId);
      if (!ticket) throw ticketNotFound();
      // Closed is terminal (lifecycle). An escalation after close is a second
      // desk inventing work on a finished complaint — refuse by code, no case
      // file, no trail noise. resolved → escalate stays legal (user not fixed).
      if (isTerminal(ticket.status)) {
        throw new SupportError('escalation refused: ticket is terminal', 'support.escalation.terminal');
      }

      const readAt = new Date().toISOString();
      const citations: SupportCitation[] = [];

      let state;
      try {
        state = await this.accounts.stateOf(ticket.userId);
      } catch (err) {
        if (err instanceof IdentityGroundingUnwiredError) {
          throw new SupportError(err.message, IDENTITY_GROUNDING_UNWIRED);
        }
        throw err;
      }
      const grounding = groundingFor(state, readAt);
      if (grounding.status === 'read') citations.push(citeAccountState(grounding.state, readAt));

      for (const id of input.citedArticleIds ?? []) {
        const article = await this.store.getPublishedKb(id);
        // Silently skipped, deliberately: refusing the whole escalation over a
        // stale / unpublished id would strand the user, and counting a missing
        // article as a citation would be the fabrication this guards against.
        if (article) citations.push(citeKbArticle(article, readAt));
      }

      for (const comment of await this.store.listComments(ticket.id)) {
        citations.push(citeComment(comment, readAt));
      }

      const built = buildCaseFile({
        ticketId: ticket.id,
        escalatedBy: input.operatorId,
        reason: input.reason,
        summary: input.summary,
        citations,
        grounding,
      });

      if (built.status === 'refuse') {
        throw new SupportError(`escalation refused: ${built.reason}`, `support.case_file.${built.reason}`);
      }

      // Case file + escalated trail row commit together. A crash between the
      // two writes used to leave a case file with no trail — desk incomplete.
      // The pre-read above is not the lock. This call locks the ticket and
      // refuses a close that landed during identity and KB work.
      const stored = await this.store.putCaseFileWithEscalated({
        caseFile: built.caseFile,
        actorId: input.operatorId,
        note: `reason:${input.reason} citations:${built.caseFile.citations.length}`,
      });
      if (stored.status === 'refuse') {
        if (stored.reason === 'not_found') throw ticketNotFound();
        throw new SupportError('escalation refused: ticket is terminal', 'support.escalation.terminal');
      }

      span.setAttribute('intafaced.support.ticket_id', ticket.id);
      span.setAttribute('intafaced.support.escalation_reason', input.reason);
      span.setAttribute('intafaced.support.citation_count', stored.caseFile.citations.length);

      return stored.caseFile;
    });
  }

  /**
   * The case file an escalation was made against — so the escalation does not
   * arrive as a bare status with a story that has to be reconstructed.
   * `null` when the ticket was never escalated; never a fabricated empty file.
   */
  async getCaseFile(input: { operatorId: string; ticketId: string }): Promise<SupportCaseFile | null> {
    await this.assertDeskVisible(input.operatorId, input.ticketId);
    const ticket = await this.store.findById(input.ticketId);
    if (!ticket) throw ticketNotFound();
    return this.store.latestCaseFile(ticket.id);
  }

  async listKb(options: { limit?: number; viewer?: SupportKbViewer } = {}): Promise<SupportKbArticle[]> {
    const limit = assertListKbLimit(options.limit);
    const viewer = options.viewer ?? ANONYMOUS_KB_VIEWER;
    // The store applies the audience before the page, so a hidden article takes no place in it and shows in no count.
    const page = await this.store.listPublishedKb({ limit, audiences: audiencesFor(viewer) });
    return this.visibleKb(page, viewer).map(toPublicKb);
  }

  /**
   * Search published KB by id/key fragment, then page.
   * Empty query → published catalog, then slice. Blank limit refuses
   * (`support.list_kb_limit_unset`) — never invent 100 / catalog.length.
   * Only articles the viewer's audience allows are searched.
   */
  async searchKb(query: string, options: { limit?: number; viewer?: SupportKbViewer } = {}): Promise<SupportKbArticle[]> {
    const limit = assertListKbLimit(options.limit);
    const viewer = options.viewer ?? ANONYMOUS_KB_VIEWER;
    const hits = searchKb(query, this.visibleKb(await this.store.listPublishedKb({ audiences: audiencesFor(viewer) }), viewer));
    return [...hits].slice(0, limit).map(toPublicKb);
  }

  /** A hidden article answers exactly like a missing one: null, never a refusal that names it. */
  async getKbArticle(
    idOrQuery: string | { id: string; version?: number },
    options: { viewer?: SupportKbViewer } = {},
  ): Promise<SupportKbArticle | null> {
    const query = typeof idOrQuery === 'string' ? { id: idOrQuery } : idOrQuery;
    const viewer = options.viewer ?? ANONYMOUS_KB_VIEWER;
    if (query.version === undefined) {
      const article = await this.store.getPublishedKb(query.id);
      return article && kbAudienceVisibleTo(article.audience, viewer) ? toPublicKb(article) : null;
    }
    try {
      const history = await this.store.listKbVersions(query.id);
      // The head decides first, so an unknown version of a hidden article is not told apart from a missing one.
      const head = history[history.length - 1];
      if (head && !kbAudienceVisibleTo(head.audience, viewer)) return null;
      const article = getKb({ id: query.id, version: query.version }, history);
      return article && kbAudienceVisibleTo(article.audience, viewer) ? toPublicKb(article) : null;
    } catch (err) {
      if (err instanceof KbCatalogError) throw new SupportError(err.message, err.code);
      throw err;
    }
  }

  private visibleKb(articles: readonly SupportKbArticle[], viewer: SupportKbViewer): SupportKbArticle[] {
    return articles.filter((article) => kbAudienceVisibleTo(article.audience, viewer));
  }

  /**
   * Operator change of who may read an article. Stale `baseRevision` refuses `support.kb.revision_stale`;
   * an unknown article is `support.kb_invalid`. The same audience again changes nothing and writes no audit row.
   */
  async setKbAudience(input: {
    operatorId: string;
    id: string;
    baseRevision: number;
    audience: SupportKbAudience;
  }): Promise<SupportKbArticle> {
    return withSupportSpan('support.setKbAudience', { op: 'setKbAudience' }, async () => {
      if (!(SUPPORT_KB_AUDIENCES as readonly string[]).includes(input.audience)) {
        throw new SupportError('audience must be public, signed_in or staff', KB_AUDIENCE_INVALID);
      }
      const result = await this.store.setKbAudience({
        id: input.id,
        baseRevision: input.baseRevision,
        audience: input.audience,
        actorId: input.operatorId,
      });
      if (result.status === 'refuse') {
        if (result.reason === 'revision_stale') throw new SupportError('KB revision is stale', 'support.kb.revision_stale');
        throw new SupportError('KB article refused', 'support.kb_invalid');
      }
      return toPublicKb(result.article);
    });
  }

  /**
   * Operator publish. Bumps revision. Stale baseRevision refuses.
   * `baseRevision` 0 creates a new published row at revision 1.
   */
  async publishKb(input: {
    id: string;
    titleKey: string;
    bodyKey: string;
    baseRevision: number;
    category?: string | null;
    tags?: readonly string[] | null;
  }): Promise<SupportKbArticle> {
    let topic: { category: string | null; tags: string[] | null };
    try {
      assertKbArticle({ id: input.id, titleKey: input.titleKey, bodyKey: input.bodyKey });
      topic = assertKbTopic({ category: input.category, tags: input.tags });
    } catch (err) {
      if (err instanceof KbCatalogError) throw new SupportError(err.message, err.code);
      throw err;
    }
    const result = await this.store.putKbRevision({
      id: input.id,
      titleKey: input.titleKey,
      bodyKey: input.bodyKey,
      baseRevision: input.baseRevision,
      published: true,
      category: topic.category,
      tags: topic.tags,
    });
    if (result.status === 'refuse') {
      if (result.reason === 'revision_stale') {
        throw new SupportError('KB revision is stale', 'support.kb.revision_stale');
      }
      throw new SupportError('KB article refused', result.reason === 'vendor' ? 'support.kb_vendor_name' : 'support.kb_invalid');
    }
    return toPublicKb(result.article);
  }

  /** Operator unpublish. Unpublished never appears on public list/search/get. */
  async unpublishKb(input: { id: string; baseRevision: number }): Promise<SupportKbArticle> {
    const result = await this.store.putKbRevision({
      id: input.id,
      baseRevision: input.baseRevision,
      published: false,
    });
    if (result.status === 'refuse') {
      if (result.reason === 'revision_stale') {
        throw new SupportError('KB revision is stale', 'support.kb.revision_stale');
      }
      throw new SupportError('KB article refused', 'support.kb_invalid');
    }
    return toPublicKb(result.article);
  }

  /** Stage-2 — prioritised open/pending queue for operators. No money. */
  async listOperatorQueue(options: { limit?: number; viewerId?: string; label?: string } = {}): Promise<QueueResult> {
    return withSupportSpan('support.listOperatorQueue', { op: 'listOperatorQueue' }, async () => {
      const limit = assertOperatorQueueLimit(options.limit);
      let tickets = await this.visibleTickets(options.viewerId, await this.store.listAll());
      if (options.label !== undefined) {
        if (!supportLabelSchema.safeParse(options.label).success) throw new SupportError('label is not valid', 'support.label_invalid');
        const carrying = await this.properties.ticketsWithLabel(options.label);
        tickets = tickets.filter((t) => carrying.has(t.id));
      }
      return buildOperatorQueue(tickets, { limit });
    });
  }

  /** Stage-2 — peek next queue ticket without claiming. */
  async peekNext(viewerId?: string): Promise<QueueEntry | null> {
    return withSupportSpan('support.peekNext', { op: 'peekNext' }, async () => {
      const tickets = await this.visibleTickets(viewerId, await this.store.listAll());
      return assignNext(tickets);
    });
  }

  /**
   * Stage-2 — exclusive operator claim via store (atomic on Postgres).
   * Refuse steal / closed tickets. Never invents refund money.
   */
  async claimForOperator(input: { operatorId: string; ticketId: string }): Promise<SupportTicket> {
    return withSupportSpan('support.claimForOperator', { op: 'claimForOperator' }, async (span) => {
      await this.assertDeskVisible(
        input.operatorId,
        input.ticketId,
        () => new SupportError('claim refused: not_found', 'support.claim.not_found'),
      );
      const result = await this.store.claimTicket({
        ticketId: input.ticketId,
        operatorId: input.operatorId,
      });
      if (result.status === 'refuse') {
        throw new SupportError(`claim refused: ${result.reason}`, `support.claim.${result.reason}`);
      }
      span.setAttribute('intafaced.support.ticket_id', result.ticket.id);
      span.setAttribute('intafaced.support.assignee_id', input.operatorId);
      return result.ticket;
    });
  }

  /** Whole-queue counts. Zero means the desk has that many rows, not a missing read. */
  async queueMetrics(viewerId?: string): Promise<{
    asOf: string;
    total: number;
    open: number;
    pending: number;
    onHold: number;
    resolved: number;
    closed: number;
    unassigned: number;
    claimed: number;
  }> {
    const tickets = await this.visibleTickets(viewerId, await this.store.listAll());
    const counts = { open: 0, pending: 0, onHold: 0, resolved: 0, closed: 0, unassigned: 0, claimed: 0 };
    for (const ticket of tickets) {
      counts[ticket.status === 'on_hold' ? 'onHold' : ticket.status] += 1;
      if ((ticket.status === 'open' || ticket.status === 'pending') && ticket.assigneeId === null) counts.unassigned += 1;
      if ((ticket.status === 'open' || ticket.status === 'pending') && ticket.assigneeId !== null) counts.claimed += 1;
    }
    return { asOf: new Date().toISOString(), total: tickets.length, ...counts };
  }

  /** The caller's own tickets that already carry a rating. Only the caller's ids: a list uses it to offer "rate this" on the rest. */
  async ratedTicketIds(userId: string): Promise<string[]> {
    return this.store.listRatedTicketIdsFor(userId);
  }

  /**
   * Founder view of satisfaction ratings for the requests solved in a stated
   * window: solved means resolved or closed now with the last change inside
   * [from, to). Counts per score, responses, solved requests and the rated
   * share in basis points (null with no solved request). The caller states
   * the window; there is no default. With no ratings it returns zero
   * responses and the screen shows no average.
   */
  async ratingSummary(input: { viewerId?: string; from: string; to: string }): Promise<{
    from: string;
    to: string;
    solved: number;
    responses: number;
    perScore: Record<'1' | '2' | '3' | '4' | '5', number>;
    ratedShareBasisPoints: number | null;
  }> {
    const from = Date.parse(input.from);
    const to = Date.parse(input.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      throw new SupportError('the window must start before it ends', 'support.rating_window_invalid');
    }
    const solved = (await this.visibleTickets(input.viewerId, await this.store.listAll())).filter((ticket) => {
      const at = Date.parse(ticket.updatedAt);
      return (ticket.status === 'resolved' || ticket.status === 'closed') && at >= from && at < to;
    });
    const ids = new Set(solved.map((ticket) => ticket.id));
    const perScore = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    let responses = 0;
    for (const rating of await this.store.listRatings()) {
      if (!ids.has(rating.ticketId)) continue;
      perScore[String(rating.score) as keyof typeof perScore] += 1;
      responses += 1;
    }
    return {
      from: input.from,
      to: input.to,
      solved: solved.length,
      responses,
      perScore,
      ratedShareBasisPoints: solved.length === 0 ? null : Math.floor((responses * 10000) / solved.length),
    };
  }

  /** True once any desk group exists, so list doors must apply the viewer's scope. */
  async deskIsRestricted(): Promise<boolean> {
    return (await this.groups.list()).length > 0;
  }

  /** `listAllTickets` for a restricted desk: scope is applied before the page is cut, so a page holds only visible rows. */
  async listAllTicketsInScope(options: { limit?: number; viewerId: string }): Promise<SupportTicket[]> {
    return withSupportSpan('support.listAllTicketsInScope', { op: 'listAllTicketsInScope' }, async () => {
      const limit = assertListAllTicketsLimit(options.limit);
      return (await this.visibleTickets(options.viewerId, await this.store.listAll())).slice(0, limit);
    });
  }

  /** Who the ticket waits on, the first public reply and the request it follows. Staff only. */
  async getTicketLifecycle(input: { operatorId: string; ticketId: string }): Promise<SupportTicketLifecycle> {
    await this.assertDeskVisible(input.operatorId, input.ticketId);
    if (!(await this.store.findById(input.ticketId))) throw ticketNotFound();
    return this.lifecycle.get(input.ticketId);
  }

  async getTicketProperties(input: { operatorId: string; ticketId: string }): Promise<SupportTicketProperties> {
    await this.assertDeskVisible(input.operatorId, input.ticketId);
    if (!(await this.store.findById(input.ticketId))) throw ticketNotFound();
    return this.properties.get(input.ticketId);
  }

  /**
   * An operator sets priority, type and labels. Omitted fields are left alone,
   * null clears priority or type, labels replace the set. A repeat of the same
   * client request id returns the first answer; a changed set writes one log
   * row with the operator and reason. A closed ticket takes no further writes.
   */
  async setTicketProperties(input: {
    operatorId: string;
    ticketId: string;
    priority?: string | null;
    ticketType?: string | null;
    labels?: string[];
    reason?: string;
    clientRequestId: string;
  }): Promise<SupportTicketProperties> {
    this.requireClientRequestId(input.clientRequestId);
    const priority = parseEnumField(supportTicketPrioritySchema, input.priority);
    const ticketType = parseEnumField(supportTicketTypeSchema, input.ticketType);
    if (priority === INVALID || ticketType === INVALID) {
      throw new SupportError('priority or type is not one of the allowed values', 'support.property_invalid');
    }
    if (
      input.labels !== undefined &&
      (input.labels.length > SUPPORT_LABELS_MAX || !input.labels.every((l) => supportLabelSchema.safeParse(l).success))
    ) {
      throw new SupportError('a label may hold letters, digits, hyphen and underscore only', 'support.label_invalid');
    }
    if (priority === undefined && ticketType === undefined && input.labels === undefined) {
      throw new SupportError('set at least one of priority, type or labels', 'support.property_invalid');
    }
    const change = { priority, ticketType };
    const labels = input.labels === undefined ? undefined : normaliseLabels(input.labels);
    return this.withIdempotency(
      `props:${input.operatorId}:${input.clientRequestId}`,
      JSON.stringify([input.ticketId, change.priority ?? null, change.ticketType ?? null, labels ?? null, input.reason ?? null]),
      async () => {
        await this.assertDeskVisible(input.operatorId, input.ticketId);
        const ticket = await this.store.findById(input.ticketId);
        if (!ticket) throw ticketNotFound();
        if (ticket.status === 'closed') throw new SupportError('a closed request takes no further changes', 'support.ticket_closed');
        return this.properties.set({
          ticketId: input.ticketId,
          ...change,
          ...(labels === undefined ? {} : { labels }),
          by: input.operatorId,
          reason: input.reason?.trim() ? input.reason.trim() : null,
          at: this.now().toISOString(),
        });
      },
    );
  }

  async listStaff(): Promise<StaffMember[]> {
    return (await this.staff.list()).map((member) => this.withEffectiveAvailability(member));
  }

  /** Whether the automatic offline window is an owner value or still blank. */
  staffAvailabilityPolicy(): { automaticOffline: 'set' | 'not_set'; heartbeatWindowSeconds: number | null } {
    return {
      automaticOffline: this.heartbeatWindowSeconds === null ? 'not_set' : 'set',
      heartbeatWindowSeconds: this.heartbeatWindowSeconds,
    };
  }

  private withEffectiveAvailability(member: StaffMember): StaffMember {
    if (this.heartbeatWindowSeconds === null || member.availability === 'offline') return member;
    const beat = member.lastHeartbeatAt ? Date.parse(member.lastHeartbeatAt) : Number.NEGATIVE_INFINITY;
    return this.now().getTime() - beat > this.heartbeatWindowSeconds * 1000 ? { ...member, availability: 'offline' } : member;
  }

  /**
   * An agent sets their own availability; a lead sets anyone's, and that
   * change is logged with the lead and the reason. Setting the value a
   * member already has writes nothing. Going online or busy counts as a
   * heartbeat when a window is set, so the agent does not read offline
   * the moment they arrive.
   */
  async setStaffAvailability(input: {
    actorId: string;
    userId: string;
    availability: StaffAvailability;
    reason?: string | null;
  }): Promise<StaffMember> {
    if (!STAFF_AVAILABILITIES.includes(input.availability)) {
      throw new SupportError('availability must be online, busy or offline', 'support.availability_invalid');
    }
    const actor = await this.staff.get(input.actorId);
    if (!actor) throw new SupportError('only staff can set availability', 'support.not_staff');
    if (input.userId !== input.actorId && actor.role !== 'lead') {
      throw new SupportError("only a lead can set someone else's availability", 'support.not_lead');
    }
    const at = this.now().toISOString();
    const stored = await this.staff.setAvailability({
      userId: input.userId,
      value: input.availability,
      by: input.actorId,
      reason: input.reason?.trim() ? input.reason.trim() : null,
      at,
      heartbeat: this.heartbeatWindowSeconds !== null && input.availability !== 'offline',
    });
    if (!stored) throw new SupportError('that person is not on the desk staff', 'support.not_staff');
    return this.withEffectiveAvailability(stored);
  }

  /** Own heartbeat. Refuses while the owner has not set the window. */
  async staffHeartbeat(input: { actorId: string }): Promise<StaffMember> {
    if (this.heartbeatWindowSeconds === null) {
      throw new SupportError('automatic offline window is not set', 'support.heartbeat_window_unset');
    }
    const stored = await this.staff.heartbeat(input.actorId, this.now().toISOString());
    if (!stored) throw new SupportError('only staff can send a heartbeat', 'support.not_staff');
    return this.withEffectiveAvailability(stored);
  }

  async appointStaff(input: { actorId: string; userId: string; role: StaffRole; idempotencyKey: string }): Promise<StaffMember> {
    return this.withIdempotency(`appoint:${input.idempotencyKey}`, `${input.actorId}:${input.userId}:${input.role}`, async () => {
      const existing = await this.staff.list();
      const actor = await this.staff.get(input.actorId);
      if (existing.length === 0) {
        if (input.role !== 'lead') throw new SupportError('the first staff appointment must be a lead', 'support.staff_bootstrap');
      } else if (actor?.role !== 'lead') {
        throw new SupportError('only a lead can appoint staff', 'support.not_lead');
      }
      return this.staff.appoint({ userId: input.userId, role: input.role, by: input.actorId, at: new Date().toISOString() });
    });
  }

  async unclaim(input: { operatorId: string; ticketId: string; idempotencyKey: string }): Promise<SupportTicket> {
    return this.withIdempotency(`unclaim:${input.idempotencyKey}`, `${input.operatorId}:${input.ticketId}`, async () => {
      await this.assertDeskVisible(
        input.operatorId,
        input.ticketId,
        () => new SupportError('unclaim refused: not_found', 'support.release.not_found'),
      );
      const result = await this.store.releaseTicket({ ticketId: input.ticketId, operatorId: input.operatorId });
      if (result.status === 'refuse') throw new SupportError(`unclaim refused: ${result.reason}`, `support.release.${result.reason}`);
      return result.ticket;
    });
  }

  /**
   * Owner close. The lifecycle table decides whether `closed` is legal from
   * the current status. A replay returns the first ticket and writes no
   * second audit row.
   */
  async close(input: { userId: string; ticketId: string; clientRequestId: string }): Promise<SupportTicket> {
    return withSupportSpan('support.close', { op: 'close', ticketId: input.ticketId }, async () => {
      this.requireClientRequestId(input.clientRequestId);
      const result = await this.store.closeByOwner(input);
      if (result.status === 'refuse') {
        if (result.reason === 'not_found') throw ticketNotFound();
        if (result.reason === 'settle') throw new SupportError('support cannot settle', SUPPORT_SETTLE_REFUSE);
        throw new SupportError(
          `status change refused: ${result.reason}`,
          `support.transition_${result.reason === 'same_status' ? 'same_status' : 'illegal'}`,
        );
      }
      return result.ticket;
    });
  }

  /** Assign or reassign. Only a lead, and only onto someone already on the staff list. */
  async assignTo(input: { operatorId: string; assigneeId: string; ticketId: string; idempotencyKey: string }): Promise<SupportTicket> {
    return this.withIdempotency(`assign:${input.idempotencyKey}`, `${input.operatorId}:${input.assigneeId}:${input.ticketId}`, async () => {
      const actor = await this.staff.get(input.operatorId);
      if (actor?.role !== 'lead') throw new SupportError('only a lead can assign a ticket', 'support.not_lead');
      const target = await this.staff.get(input.assigneeId);
      if (!target) throw new SupportError('assignee is not desk staff', 'support.not_staff');
      await this.assertDeskVisible(
        input.operatorId,
        input.ticketId,
        () => new SupportError('assign refused: not_found', 'support.assign.not_found'),
      );
      const result = await this.store.assignTicket({
        ticketId: input.ticketId,
        operatorId: input.operatorId,
        assigneeId: input.assigneeId,
      });
      if (result.status === 'refuse') throw new SupportError(`assign refused: ${result.reason}`, `support.assign.${result.reason}`);
      return result.ticket;
    });
  }

  /** Owner rating. Once per ticket. Replay of the same key returns the first rating. */
  async rate(input: {
    userId: string;
    ticketId: string;
    score: number;
    note?: string | null;
    clientRequestId: string;
  }): Promise<TicketRating> {
    return withSupportSpan('support.rate', { op: 'rate', ticketId: input.ticketId }, async () => {
      this.requireClientRequestId(input.clientRequestId);
      const result = await this.store.rateByOwner(input);
      if (result.status === 'refuse') {
        if (result.reason === 'not_found') throw ticketNotFound();
        if (result.reason === 'already_rated') throw new SupportError('ticket already rated', 'support.already_rated');
        if (result.reason === 'score') throw new SupportError('rating score out of range', 'support.rate_score_out_of_range');
        if (result.reason === 'note') throw new SupportError('rating note too long', 'support.rate_note_too_long');
        throw new SupportError('rating refused for this status', 'support.rate_status_refused');
      }
      return result.rating;
    });
  }

  /** Owner reads their rating. Operators with support:ops read any ticket. */
  async rating(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<TicketRating | null> {
    return withSupportSpan('support.rating', { op: 'rating', ticketId: input.ticketId }, async () => {
      if (input.asOperator === true) await this.assertDeskVisible(input.userId, input.ticketId);
      const result = await this.store.readRating({
        userId: input.userId,
        ticketId: input.ticketId,
        asOperator: input.asOperator === true,
      });
      if (result.status === 'refuse') throw ticketNotFound();
      return result.rating;
    });
  }

  /**
   * Owner attach. With no store, scanner, or size and type limits, refuses
   * `support.attachments_unconfigured` and stores nothing. A file is written
   * only after the scanner returns clean.
   */
  async attach(input: {
    userId: string;
    ticketId: string;
    clientRequestId: string;
    contentType: string;
    bodyBase64: string;
  }): Promise<AttachmentMeta> {
    return withSupportSpan('support.attach', { op: 'attach', ticketId: input.ticketId }, async () => {
      this.requireClientRequestId(input.clientRequestId);
      const desk = await this.attachmentDesk();
      const missing = missingAttachmentKey(desk);
      if (missing) {
        throw new SupportError('attachments are not configured', 'support.attachments_unconfigured', missing);
      }
      if (desk.maxCount == null) {
        throw new SupportError('attachment count is not set', 'support.attachment_count_unset', ATTACHMENT_MAX_COUNT_KEY);
      }
      const bytes = decodeAttachmentBody(input.bodyBase64);
      if (!bytes) throw new SupportError('attachment body is not base64', 'support.attachment_body_invalid');
      const replay = await this.store.readReceipt('support.attach', input.userId, input.clientRequestId);
      if (replay && typeof replay === 'object' && replay !== null && 'attachment' in replay) {
        // A reply that was lost is answered from the file as it now stands, never scanned or counted a second time.
        const first = (replay as { attachment: AttachmentMeta }).attachment;
        const live = await this.store.readAttachment({ userId: input.userId, attachmentId: first.id, asOperator: false });
        const meta = live.status === 'ok' ? live.attachment : first;
        if (meta.scanState === 'clean') return meta;
        if (meta.scanState === 'blocked') throw scanRefused();
        // A held file is scanned from the bytes this retry carries, so they must be the bytes it was first sent with.
        if (bytes.byteLength !== meta.byteLength) {
          throw new SupportError('attachment body is not the one first sent', 'support.attachment_body_invalid');
        }
        return this.settleScan(desk, meta, bytes);
      }

      const maxBytes = desk.maxBytes!;
      if (bytes.byteLength > maxBytes) {
        throw new SupportError('attachment exceeds the configured size', 'support.attachment_too_large');
      }
      const allowed = desk.allowedTypes!;
      if (!allowed.includes(input.contentType)) {
        throw new SupportError('attachment type is not in the configured list', 'support.attachment_type_refused');
      }

      const id = randomUUID();
      const storeKey = `${input.ticketId}/${id}`;
      // The row is written first, as `scanning`: whatever happens after this, the file is on record and is not served.
      const recorded = await this.store.recordAttachment({
        id,
        userId: input.userId,
        ticketId: input.ticketId,
        clientRequestId: input.clientRequestId,
        storeKey,
        contentType: input.contentType,
        byteLength: bytes.byteLength,
        maxCount: desk.maxCount,
      });
      if (recorded.status === 'refuse') {
        if (recorded.reason === 'count_reached') {
          throw new SupportError('the request already holds its limit of files', 'support.attachment_count_reached');
        }
        throw ticketNotFound();
      }
      if (recorded.attachment.scanState === 'clean') return recorded.attachment;
      if (recorded.attachment.scanState === 'blocked') throw scanRefused();
      return this.settleScan(desk, recorded.attachment, bytes);
    });
  }

  /**
   * Scans a file that is `scanning` and records the answer. Clean bytes are written to the store before the row is marked
   * clean, so a crash between the two leaves a held file that a later pass scans again; it is never marked clean without a
   * verdict. Infected bytes are never stored. When the scanner cannot answer, the bytes are kept so the file can be scanned
   * again, the row stays `scanning`, and the caller is told `support.attachment_scan_unknown`.
   */
  private async settleScan(desk: AttachmentDesk, meta: AttachmentMeta, bytes: Uint8Array): Promise<AttachmentMeta> {
    let verdict: ScanVerdict;
    try {
      verdict = await desk.scanner!.scan(bytes);
    } catch {
      verdict = 'unknown';
    }
    if (verdict === 'infected') {
      await this.store.setAttachmentScanState({ attachmentId: meta.id, state: 'blocked' });
      throw scanRefused();
    }
    await desk.store!.put({ key: meta.storeKey, bytes, contentType: meta.contentType });
    if (verdict !== 'clean') {
      throw new SupportError('the scanner could not say whether the attachment is safe', 'support.attachment_scan_unknown');
    }
    const settled = await this.store.setAttachmentScanState({ attachmentId: meta.id, state: 'clean' });
    if (!settled) throw ticketNotFound();
    if (settled.scanState === 'blocked') throw scanRefused();
    return settled;
  }

  /**
   * Scans again the files a crash or a scanner outage left `scanning`, oldest first, at most `limit`. A file whose bytes are
   * not in the store (the crash came before they were written) is left held: nothing here can invent them, and the owner's
   * retry under the same request id writes them. Returns how many files were settled.
   */
  async rescanHeldAttachments(limit: number): Promise<{ clean: number; blocked: number; held: number }> {
    const out = { clean: 0, blocked: 0, held: 0 };
    const desk = await this.attachmentDesk();
    if (missingAttachmentKey(desk)) return out;
    for (const meta of await this.store.listScanningAttachments(limit)) {
      const object = await desk.store!.get(meta.storeKey);
      if (!object) {
        out.held += 1;
        continue;
      }
      try {
        const settled = await this.settleScan(desk, meta, object.bytes);
        if (settled.scanState === 'clean') out.clean += 1;
      } catch (err) {
        if (err instanceof SupportError && err.code === 'support.attachment_scan_refused') out.blocked += 1;
        else if (err instanceof SupportError && err.code === 'support.attachment_scan_unknown') out.held += 1;
        else throw err;
      }
    }
    return out;
  }

  /**
   * One stored file's bytes, to its owner or to the operator the ticket is assigned to, and only when the scanner said
   * clean. Someone else's file answers exactly like no file. A file that is still scanning is held with
   * `support.attachment_scan_unknown`, a blocked file is never served, and the content type is fixed here, never the uploader's.
   */
  async attachmentDownload(input: { userId: string; attachmentId: string; asOperator?: boolean }): Promise<SupportAttachmentDownload> {
    return withSupportSpan('support.attachmentDownload', { op: 'attachmentDownload' }, async () => {
      const result = await this.store.readAttachment({
        userId: input.userId,
        attachmentId: input.attachmentId,
        asOperator: input.asOperator === true,
      });
      if (result.status === 'refuse') throw ticketNotFound();
      const meta = result.attachment;
      if (meta.scanState === 'blocked') throw scanRefused();
      if (meta.scanState !== 'clean') {
        throw new SupportError('the attachment has not been scanned yet', 'support.attachment_scan_unknown');
      }
      const desk = await this.attachmentDesk();
      const missing = missingAttachmentKey(desk);
      if (missing) throw new SupportError('attachments are not configured', 'support.attachments_unconfigured', missing);
      const object = await desk.store!.get(meta.storeKey);
      if (!object) throw ticketNotFound();
      return {
        id: meta.id,
        contentType: SUPPORT_ATTACHMENT_DOWNLOAD_TYPE,
        disposition: 'attachment',
        byteLength: object.bytes.byteLength,
        bodyBase64: Buffer.from(object.bytes).toString('base64'),
      };
    });
  }

  /**
   * The desk an attach runs against: the deployment's store and scanner, and each limit from the deployment when it
   * supplied one and otherwise from the owner's settings. A limit neither has stays blank.
   */
  private async attachmentDesk(): Promise<AttachmentDesk & { maxCount: number | null }> {
    const limits = await this.attachmentSettings.get();
    return {
      store: this.attachments.store,
      scanner: this.attachments.scanner,
      maxBytes: this.attachments.maxBytes ?? limits.maxBytes,
      allowedTypes: this.attachments.allowedTypes ?? limits.allowedTypes,
      maxCount: this.attachments.maxCount ?? limits.maxCount,
    };
  }

  /** The limits as a customer or an operator reads them, with the first piece an attach is missing. */
  async attachmentLimits(): Promise<SupportAttachmentLimits> {
    const desk = await this.attachmentDesk();
    const limits = await this.attachmentSettings.get();
    return {
      maxBytes: desk.maxBytes,
      allowedTypes: desk.allowedTypes === null ? null : [...desk.allowedTypes],
      maxCount: desk.maxCount,
      missing: (missingAttachmentKey(desk) ??
        (desk.maxCount == null ? ATTACHMENT_MAX_COUNT_KEY : null)) as SupportAttachmentLimits['missing'],
      revision: limits.revision,
      updatedAt: limits.updatedAt,
    };
  }

  /** Each of the five pieces an attach needs and whether it is set, in the order it needs them. */
  async attachmentStatus(): Promise<SupportAttachmentStatus> {
    const limits = await this.attachmentLimits();
    const desk = await this.attachmentDesk();
    const set: Record<SupportAttachmentKey, boolean> = {
      'support.attachment_store': desk.store != null,
      'support.malware_scanner': desk.scanner != null,
      'support.attachment_max_bytes': limits.maxBytes !== null,
      'support.attachment_allowed_types': limits.allowedTypes !== null,
      'support.attachment_max_count': limits.maxCount !== null,
    };
    return { pieces: SUPPORT_ATTACHMENT_KEYS.map((key) => ({ key, set: set[key] })), limits };
  }

  /**
   * The files on one ticket with their scan state, to its owner or to an operator who may see the ticket. A ticket the
   * caller may not see answers as no such ticket. The page size is the caller's and a blank one refuses.
   */
  async listAttachments(input: { userId: string; ticketId: string; asOperator?: boolean; limit?: number }): Promise<AttachmentMeta[]> {
    return withSupportSpan('support.ticketAttachments', { op: 'ticketAttachments', ticketId: input.ticketId }, async () => {
      const limit = assertListAttachmentsLimit(input.limit);
      await this.getTicket({ userId: input.userId, ticketId: input.ticketId, asOperator: input.asOperator });
      return this.store.listAttachmentsFor(input.ticketId, limit);
    });
  }

  /** Owner reads their attachment metadata. An operator reads one only on a ticket they are assigned. */
  async attachment(input: { userId: string; attachmentId: string; asOperator?: boolean }): Promise<AttachmentMeta> {
    return withSupportSpan('support.attachment', { op: 'attachment' }, async () => {
      const result = await this.store.readAttachment({
        userId: input.userId,
        attachmentId: input.attachmentId,
        asOperator: input.asOperator === true,
      });
      if (result.status === 'refuse') throw ticketNotFound();
      return result.attachment;
    });
  }

  /** One vote per account per published version. A repeat returns the first vote and updates nothing. */
  async kbFeedback(input: {
    userId: string;
    id: string;
    helpful: boolean;
    clientRequestId: string;
    viewer?: SupportKbViewer;
  }): Promise<KbFeedbackVote> {
    return withSupportSpan('support.kbFeedback', { op: 'kbFeedback' }, async () => {
      this.requireClientRequestId(input.clientRequestId);
      // A vote on an article the reader may not see answers like a vote on a missing one.
      const article = await this.store.getPublishedKb(input.id);
      if (article && !kbAudienceVisibleTo(article.audience, input.viewer ?? ANONYMOUS_KB_VIEWER)) {
        throw new SupportError('article is not published', 'support.kb.not_published');
      }
      const result = await this.store.recordKbFeedback({
        userId: input.userId,
        articleId: input.id,
        helpful: input.helpful,
        clientRequestId: input.clientRequestId,
      });
      if (result.status === 'refuse') throw new SupportError('article is not published', 'support.kb.not_published');
      return result.vote;
    });
  }

  /** Published articles sharing a category or tag. Never the article itself. */
  async kbRelated(input: { id: string; viewer?: SupportKbViewer }): Promise<SupportKbArticle[]> {
    return withSupportSpan('support.kbRelated', { op: 'kbRelated' }, async () => {
      const catalog = this.visibleKb(await this.store.listPublishedKb(), input.viewer ?? ANONYMOUS_KB_VIEWER);
      return relatedPublished(input.id, catalog);
    });
  }

  private requireClientRequestId(clientRequestId: string): void {
    const key = clientRequestId?.trim() ?? '';
    if (!key || key.length > 200) {
      throw new SupportError('client request id is required', 'support.client_request_id_required');
    }
  }
}

export function requireSupportWrite(principal: Principal): void {
  requireScope(principal, 'support:write');
}

export function requireSupportOps(principal: Principal): void {
  try {
    requireScope(principal, 'support:ops');
  } catch {
    throw new AuthError('support:ops required for operator actions', 'scope.denied');
  }
}
