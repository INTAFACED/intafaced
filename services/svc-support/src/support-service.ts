import { randomUUID } from 'node:crypto';
import { AuthError, requireScope, type Principal } from '@intafaced/auth';
import {
  SUPPORT_CATEGORY_ROUTES,
  SUPPORT_CUSTOMER_PROPERTIES_UNSET,
  type SupportCustomerProperty,
  type SupportMyTicketProperties,
  SUPPORT_FRAUD_REPORT_KEY_REQUIRED,
  SUPPORT_FRAUD_ROUTE_MISSING,
  SUPPORT_FRAUD_ROUTE_UNSET,
  supportTicketCategorySchema,
  type SupportCategories,
  SUPPORT_KB_STORED_BODY_KEY,
  SUPPORT_KB_STORED_TITLE_KEY,
  supportKbBodyProblem,
  supportKbTitleProblem,
  SUPPORT_ATTACHMENT_DOWNLOAD_TYPE,
  SUPPORT_ATTACHMENT_KEYS,
  SUPPORT_KB_AUDIENCES,
  SUPPORT_LABELS_MAX,
  kbAudienceVisibleTo,
  SUPPORT_BULK_CAP_KEY,
  SUPPORT_VIEW_PERSONAL_CAP_KEY,
  SUPPORT_VIEW_SHARED_CAP_KEY,
  supportBulkKey,
  supportLabelSchema,
  supportTicketPrioritySchema,
  supportTicketTypeSchema,
  type SupportAttachmentDownload,
  type SupportAttachmentKey,
  type SupportAttachmentLimits,
  type SupportBulkChange,
  type SupportBulkPolicy,
  type SupportBulkResult,
  type SupportMergePreview,
  type SupportMergeResult,
  type SupportAttachmentStatus,
  type SupportTicketPriority,
  type SupportAwaitingMine,
  type SupportTicketLifecycle,
  type SupportTicketProperties,
  type SupportTicketPropertyChange,
  type SupportTicketType,
  supportMacroUnfilled,
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
  SupportView,
  SupportViewList,
  SupportViewSort,
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
import {
  assertKbArticle,
  assertKbTopic,
  getKb,
  KbCatalogError,
  kbVersionOf,
  namesVendor,
  relatedPublished,
  searchKb,
  toPublicKb,
} from './kb-catalog.js';
import { isTerminal } from './lifecycle.js';
import {
  OperatorQueueLimitUnsetError,
  QUEUE_LIST_LIMIT_UNSET,
  assertOperatorQueueLimit as publishedOperatorQueueLimit,
  assignNext,
  buildOperatorQueue,
  rankOperatorQueue,
  type QueueEntry,
  type QueueResult,
} from './operator-queue.js';
import {
  MemoryViewBook,
  ViewError,
  filterMatches,
  orderFacts,
  parseDeskFilter,
  parseDeskSort,
  parseLayout,
  searchHits,
  viewCapWire,
  type DeskFact,
  type DeskFilter,
  type ViewBook,
} from './desk-views.js';
import { SUPPORT_SETTLE_REFUSE, checkSupportSettlement, type SupportForbiddenSettlementAct } from './settlement-refuse.js';
import {
  FEEDBACK_COMMENT_MAX,
  READER_ACTOR_PREFIX,
  SEARCH_QUERY_CONTRACT_MAX,
  SUPPORT_ASSISTANT_MODEL_UNSET,
  SUPPORT_FEEDBACK_RATE_EXCEEDED,
  SUPPORT_FEEDBACK_RATE_LIMIT_UNSET,
  SUPPORT_FEEDBACK_REQUEST_INVALID,
  SUPPORT_SEARCH_QUERY_TOO_LONG,
  readerActorId,
} from './kb-feedback.js';
import {
  MemorySupportStore,
  newerByOthers,
  type AttachmentMeta,
  type KbFeedbackCount,
  type KbFeedbackVote,
  type KbSearchMiss,
  type SupportStore,
  type TicketRating,
} from './store.js';
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
import { findCommentSecret, SUPPORT_COMMENT_SECRET_REFUSED } from './comment-secrets.js';

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

const heldKey = (storeKey: string): string => `held/${storeKey}`;
const scanRefused = (): SupportError => new SupportError('attachment did not pass the scanner', 'support.attachment_scan_refused');

/** The owner setting a blank comment cap names (`SUPPORT_COMMENT_CAP`). */
export const SUPPORT_COMMENT_CAP_KEY = 'support.comment_cap';

/**
 * Text a person writes onto a request (its subject and body, a reply, a staff note, a status note, an escalation summary)
 * that holds a card number or a recovery phrase is refused before anything is stored.
 */
function refuseCommentSecret(body: string): void {
  const found = findCommentSecret(body);
  if (found) throw new SupportError(`the comment holds a ${found.replace('_', ' ')}`, SUPPORT_COMMENT_SECRET_REFUSED);
}

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
/** Resolved and closed requests are finished: they wait on nobody and read as solved to their owner. */
function isFinished(status: SupportTicket['status']): boolean {
  return status === 'resolved' || status === 'closed';
}

/** A write that named an older trail row than the ticket has: what changed is in the message, and nothing was written. */
function staleTicket(newer: readonly SupportTicketEvent[]): SupportError {
  const last = newer[newer.length - 1]!;
  return new SupportError(
    `the request changed since you opened it: ${newer.length} newer trail row(s), last #${last.sequence}`,
    'support.stale_ticket',
  );
}

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

/**
 * The reader of a help door, from the signed principal and nothing else.
 * A visitor has no principal. The desk is a `support:ops` principal.
 */
export function kbViewerOf(principal: Pick<Principal, 'scopes'> | null | undefined): SupportKbViewer {
  return { signedIn: Boolean(principal), staff: Boolean(principal?.scopes.includes('support:ops')) };
}

/** The reader of a public help door when the caller did not say: a signed-out visitor sees public articles only. */
const ANONYMOUS_KB_VIEWER: SupportKbViewer = kbViewerOf(null);

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
    /** How many requests one bulk change may hold. Owner value; blank (null) refuses `support.bulk_cap_unset`. */
    private readonly bulkCap: number | null = null,
    /**
     * SP-kb-03 owner values. A blank rate refuses every vote, an account's or a public one. A blank model
     * refuses the answer panel. A blank search maximum leaves the contract bound.
     * The model string is never returned, logged or sent on.
     */
    private readonly kbDesk: {
      feedbackRateLimit?: number | null;
      feedbackRateWindowSeconds?: number | null;
      assistantModel?: string | null;
      searchQueryMax?: number | null;
    } = {
      feedbackRateLimit: null,
      feedbackRateWindowSeconds: null,
      assistantModel: null,
      searchQueryMax: null,
    },
    /**
     * How many comments a requester may add to one request (SP-api-01). Owner value; blank (null) refuses a requester's
     * comment `support.comment_cap_unset`. Operators are not counted and not capped.
     */
    private readonly commentCap: number | null = null,
    /** Saved views. Caps stay null until the owner sets them; a save then refuses rather than guessing 10 or 100. */
    private readonly views: ViewBook = new MemoryViewBook({ personal: null, shared: null }),
    /**
     * The name of the desk group fraud reports go to (SP-tickets-01). Owner value; blank (null) refuses a fraud report
     * `support.fraud_route_unset` rather than leaving it on the open desk.
     */
    private readonly fraudGroupName: string | null = null,
    /**
     * Which agent-set properties a customer reads on their own request (SP-tickets-04): any of priority and type, or
     * none. Owner value; blank (null) reads `unset` and shows the customer neither.
     */
    private readonly customerSees: readonly SupportCustomerProperty[] | null = null,
  ) {}

  /** The priority and type the owner lets a customer read on their own request. Anyone else's reads as not found. */
  async myTicketProperties(input: { userId: string; ticketId: string }): Promise<SupportMyTicketProperties> {
    const ticket = await this.store.findById(input.ticketId);
    if (!ticket || ticket.userId !== input.userId) throw ticketNotFound();
    if (this.customerSees === null) return { status: 'unset', code: SUPPORT_CUSTOMER_PROPERTIES_UNSET };
    const props = await this.properties.get(ticket.id);
    return {
      status: 'ok',
      priority: this.customerSees.includes('priority') ? { value: props.priority } : null,
      ticketType: this.customerSees.includes('type') ? { value: props.ticketType } : null,
    };
  }

  /** The group a fraud report goes to, or the refusal that says why none can be sent now. */
  private async fraudRoute(): Promise<
    { groupId: string } | { refusal: typeof SUPPORT_FRAUD_ROUTE_UNSET | typeof SUPPORT_FRAUD_ROUTE_MISSING }
  > {
    if (this.fraudGroupName === null) return { refusal: SUPPORT_FRAUD_ROUTE_UNSET };
    const group = (await this.groups.list()).find((row) => row.name === this.fraudGroupName);
    return group ? { groupId: group.id } : { refusal: SUPPORT_FRAUD_ROUTE_MISSING };
  }

  /** The categories a person can send, where each goes, and which cannot be sent now and why. */
  async categories(): Promise<SupportCategories> {
    const fraud = await this.fraudRoute();
    return {
      categories: supportTicketCategorySchema.options.map((id) => ({
        id,
        routesTo: SUPPORT_CATEGORY_ROUTES[id],
        refusal: SUPPORT_CATEGORY_ROUTES[id] === 'compliance' && 'refusal' in fraud ? fraud.refusal : null,
      })),
    };
  }

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

  private async requireLead(actorId: string, message = 'only a lead can change desk groups'): Promise<void> {
    const actor = await this.staff.get(actorId);
    if (actor?.role !== 'lead') throw new SupportError(message, 'support.not_lead');
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
      refuseCommentSecret(`${input.subject}\n${input.body}`);
      if (input.messageHeaders !== undefined && input.category !== 'phishing') {
        throw new SupportError('message headers belong to a phishing report only', 'support.headers_not_allowed');
      }
      // A fraud report goes to the owner's compliance group; with none named or found it is refused before it exists. It
      // needs a key, so a crash between the ticket and its group is mended by the retry rather than leaving a duplicate.
      // A replay of a key that already made the report returns it once it is grouped, even if the route changed since.
      const compliance = SUPPORT_CATEGORY_ROUTES[input.category] === 'compliance';
      if (compliance && input.clientRequestId === undefined)
        throw new SupportError('a fraud report needs a request key', SUPPORT_FRAUD_REPORT_KEY_REQUIRED);
      const replay =
        compliance && input.clientRequestId !== undefined
          ? (await this.store.readReceipt('support.create', input.userId, input.clientRequestId)) !== null
          : false;
      const route = compliance ? await this.fraudRoute() : null;
      if (route && 'refusal' in route && !replay)
        throw new SupportError(
          route.refusal === SUPPORT_FRAUD_ROUTE_UNSET ? 'fraud reports have no group set' : 'the fraud report group does not exist',
          route.refusal,
        );
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
      // Grouped only while ungrouped, so a replay after a crash here groups it. Until grouped, an ungrouped ticket is read
      // by leads only (`deskCanSee`), so the gap exposes it to no agent. A group gone between the read and this write
      // refuses, and so does a replay of a report that was never grouped while the route still refuses: the customer is
      // never told a report went to compliance when it did not. The retry with the same key groups it once the route is right.
      const ungrouped = route !== null && (await this.groups.groupOfTicket(ticket.id)) === null;
      if (ungrouped && 'refusal' in route) throw new SupportError('the fraud report has not reached its group', route.refusal);
      if (ungrouped && 'groupId' in route) {
        const grouped = await this.groups.setTicketGroup({
          ticketId: ticket.id,
          groupId: route.groupId,
          by: 'support:fraud-route',
          at: ticket.createdAt,
        });
        if (grouped === 'unknown_group') throw new SupportError('the fraud report group does not exist', SUPPORT_FRAUD_ROUTE_MISSING);
      }
      span.setAttribute('intafaced.support.ticket_id', ticket.id);
      return ticket;
    });
  }

  async listMyTickets(input: { userId: string; limit?: number }): Promise<SupportTicket[]> {
    return withSupportSpan('support.listMyTickets', { op: 'listMyTickets' }, async () => {
      const limit = assertListMineTicketsLimit(input.limit);
      return this.withCustomerStatus(await this.store.listByUser(input.userId, { limit }));
    });
  }

  /**
   * The caller's own request that a `support.create` key made, as it stands now, or null when that key made none. A page
   * whose create answer was lost reads this instead of sending again (SP-tickets-01). The receipt is the caller's own, so
   * another account's key reads as none.
   */
  async createdByRequest(input: { userId: string; clientRequestId: string }): Promise<SupportTicket | null> {
    return withSupportSpan('support.createdByRequest', { op: 'createdByRequest' }, async () => {
      const receipt = (await this.store.readReceipt('support.create', input.userId, input.clientRequestId)) as {
        ticket?: { id?: unknown };
      } | null;
      const id = receipt?.ticket?.id;
      if (typeof id !== 'string') return null;
      // The owner's own read, so a merged request says what it was merged into, exactly as `get` does.
      try {
        return await this.getTicket({ userId: input.userId, ticketId: id });
      } catch (err) {
        if (err instanceof SupportError && err.code === 'support.not_found') return null;
        throw err;
      }
    });
  }

  /** Each ticket with what its owner reads as its status: whose turn it is, from the lifecycle facts. */
  private async withCustomerStatus(tickets: SupportTicket[]): Promise<SupportTicket[]> {
    const open = tickets.filter((t) => !isFinished(t.status)).map((t) => t.id);
    const waiting = new Set((await this.lifecycle.awaitingCustomer(open)).map((row) => row.ticketId));
    return tickets.map((ticket) => ({
      ...ticket,
      customerStatus: isFinished(ticket.status) ? 'solved' : waiting.has(ticket.id) ? 'awaiting_reply' : 'open',
    }));
  }

  /**
   * How many of the caller's own requests wait on them, and which has waited longest. A count and one pointer, not a list,
   * so it needs no page size. The owner's ticket reads say only whose turn it is (`customerStatus`), never the desk's
   * waiting side or since. Finished requests wait on nobody.
   */
  async awaitingMine(input: { userId: string }): Promise<SupportAwaitingMine> {
    return withSupportSpan('support.awaitingMine', { op: 'awaitingMine' }, async () => {
      const waiting = await this.lifecycle.awaitingCustomer(await this.store.openIdsByUser(input.userId));
      const first = waiting[0];
      return { count: waiting.length, longestWaiting: first ? { ticketId: first.ticketId, since: first.since } : null };
    });
  }

  async listAllTickets(options: { limit?: number; filter?: unknown; sort?: unknown; q?: string } = {}): Promise<SupportTicket[]> {
    return withSupportSpan('support.listAllTickets', { op: 'listAllTickets' }, async () => {
      const limit = assertListAllTicketsLimit(options.limit);
      if (!this.deskQueryAsked(options)) return this.store.listAll({ limit });
      const facts = orderFacts(await this.narrow(await this.deskFacts(undefined), options), this.deskSort(options.sort), this.now());
      return facts.slice(0, limit).map((fact) => fact.ticket);
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
      const merge = ticket.status === 'closed' ? await this.store.findMergeBySource(ticket.id) : null;
      const read = merge ? { ...ticket, mergedInto: merge.survivorId } : ticket;
      // The owner reads whose turn it is; a staff read of someone else's request keeps the desk's own facts.
      return ticket.userId === input.userId ? (await this.withCustomerStatus([read]))[0]! : read;
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
  async comment(input: {
    userId: string;
    ticketId: string;
    body: string;
    asOperator?: boolean;
    /** The caller's key. The same key again answers the first comment and writes nothing; with other text it refuses. */
    clientRequestId?: string;
    /** The last trail row the operator had read: a newer row by someone else refuses `support.stale_ticket`, writing nothing. */
    expectedSequence?: number;
  }): Promise<SupportComment> {
    return withSupportSpan('support.comment', { op: 'comment', ticketId: input.ticketId }, async () => {
      if (input.clientRequestId !== undefined) this.requireClientRequestId(input.clientRequestId);
      refuseCommentSecret(input.body);
      await this.getTicket({
        userId: input.userId,
        ticketId: input.ticketId,
        asOperator: input.asOperator,
      });
      // SP-desk-02: a macro placeholder whose value was blank for this request is never sent, blank or as written.
      if (input.asOperator && supportMacroUnfilled(input.body).length > 0) {
        throw new SupportError('the reply still holds a placeholder to fill', 'support.macro_placeholder_blank');
      }
      const result = await this.store.addComment({
        ticketId: input.ticketId,
        authorId: input.userId,
        authorRole: input.asOperator ? 'operator' : 'user',
        body: input.body,
        ...(input.clientRequestId !== undefined ? { clientRequestId: input.clientRequestId.trim() } : {}),
        ...(!input.asOperator ? { userCap: this.commentCap } : {}),
        ...(input.expectedSequence !== undefined ? { expectedSequence: input.expectedSequence } : {}),
      });
      if (result.status === 'refuse') {
        if (result.reason === 'not_found') throw ticketNotFound();
        if (result.reason === 'stale') throw staleTicket(result.newer);
        if (result.reason === 'cap_unset') {
          throw new SupportError('the comment cap per request is not set', 'support.comment_cap_unset', SUPPORT_COMMENT_CAP_KEY);
        }
        if (result.reason === 'cap_reached') {
          throw new SupportError('this request holds as many of your comments as it may', 'support.comment_cap_reached');
        }
        if (result.reason === 'idempotency_conflict') {
          throw new SupportError('idempotency key was already used for a different command', 'support.idempotency_conflict');
        }
        throw new SupportError('comment refused: ticket is terminal', 'support.comment.terminal');
      }
      // A replay wrote nothing. While its comment is still the request's last write, the first call may have died before
      // the lifecycle below, so the replay settles it again (both writes keep what is already set); after a later write it
      // moves nothing, or it would undo that write's side. A later write can share the comment's millisecond, so a
      // lifecycle already moved at or after the comment also counts as later.
      if (result.replay) {
        if (result.ticket.updatedAt !== result.comment.createdAt) return result.comment;
        const settled = await this.lifecycle.get(input.ticketId);
        if (settled?.waitingSince && settled.waitingSince >= result.comment.createdAt) return result.comment;
      }
      // Every comment written here is on the customer's thread (an internal note is `addInternalNote`), so an operator's is a
      // public reply: the ticket now waits on the customer and the first one is stamped once. A customer reply puts it back
      // on the team.
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

  /**
   * A staff-only note on a request (SP-tickets-05). It is never on the customer's thread, and it moves nothing the customer
   * reads: no reopen or resume, no "waiting on", no first-reply stamp and no new `updatedAt`. A blank body refuses
   * `support.note_empty`. The key is required: the same key again answers the first note and writes nothing.
   */
  async addInternalNote(input: { userId: string; ticketId: string; body: string; clientRequestId: string }): Promise<SupportComment> {
    return withSupportSpan('support.addInternalNote', { op: 'addInternalNote', ticketId: input.ticketId }, async () => {
      this.requireClientRequestId(input.clientRequestId);
      const body = input.body.trim();
      if (body === '') throw new SupportError('an internal note needs words', 'support.note_empty');
      refuseCommentSecret(body);
      await this.getTicket({ userId: input.userId, ticketId: input.ticketId, asOperator: true });
      const result = await this.store.addComment({
        ticketId: input.ticketId,
        authorId: input.userId,
        authorRole: 'operator',
        visibility: 'internal',
        body,
        clientRequestId: input.clientRequestId.trim(),
      });
      if (result.status === 'refuse') {
        if (result.reason === 'not_found') throw ticketNotFound();
        if (result.reason === 'idempotency_conflict') {
          throw new SupportError('idempotency key was already used for a different command', 'support.idempotency_conflict');
        }
        throw new Error(`an internal note was refused for a reason a note cannot have: ${result.reason}`);
      }
      return result.comment;
    });
  }

  /**
   * The request's thread, oldest first. Staff reading someone else's request also get its internal notes; the requester
   * never does, even when they are staff themselves, and the store leaves the notes out inside its query.
   */
  async listComments(input: { userId: string; ticketId: string; asOperator?: boolean; limit?: number }): Promise<SupportComment[]> {
    return withSupportSpan('support.listComments', { op: 'listComments', ticketId: input.ticketId }, async () => {
      const limit = assertListCommentsLimit(input.limit);
      const ticket = await this.getTicket({
        userId: input.userId,
        ticketId: input.ticketId,
        asOperator: input.asOperator,
      });
      if (input.asOperator === true && ticket.userId !== input.userId) {
        return this.store.listComments(input.ticketId, { limit, withInternal: true });
      }
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
  async setStatus(input: {
    operatorId: string;
    ticketId: string;
    status: SupportTicketStatus;
    note?: string;
    /** The last trail row the operator had read: a newer row by someone else refuses `support.stale_ticket`, writing nothing. */
    expectedSequence?: number;
  }): Promise<SupportTicket> {
    return withSupportSpan('support.setStatus', { op: 'setStatus', ticketId: input.ticketId }, async (span) => {
      await this.assertDeskVisible(input.operatorId, input.ticketId);
      if (input.note) refuseCommentSecret(input.note);
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
        ...(input.expectedSequence !== undefined ? { expectedSequence: input.expectedSequence } : {}),
      });
      if (result.status === 'refuse') {
        if (result.reason === 'not_found') throw ticketNotFound();
        if (result.reason === 'stale') throw staleTicket(result.newer);
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
   * the ticket's public comments (internal notes stay out of the case file), and digests each one. An article id that does not
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
      refuseCommentSecret(input.summary);
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
    const q = query.trim();
    const max = this.kbDesk.searchQueryMax;
    if ((max != null && q.length > max) || q.length > SEARCH_QUERY_CONTRACT_MAX) {
      throw new SupportError('search query is longer than the maximum', SUPPORT_SEARCH_QUERY_TOO_LONG);
    }
    const viewer = options.viewer ?? ANONYMOUS_KB_VIEWER;
    const hits = searchKb(query, this.visibleKb(await this.store.listPublishedKb({ audiences: audiencesFor(viewer) }), viewer));
    if (q.length > 0 && hits.length === 0) {
      await this.store.recordSearchMiss({ query: q, at: this.now().toISOString() });
    }
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
    /** Text typed in the desk and its section (SP-kb-01); checked by publishKbText. */
    text?: { title: string; body: string; language: string; sectionId: string };
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
      ...(input.text ? { text: input.text } : {}),
    });
    if (result.status === 'refuse') {
      if (result.reason === 'revision_stale') {
        throw new SupportError('KB revision is stale', 'support.kb.revision_stale');
      }
      if (result.reason === 'section_unknown') throw new SupportError('KB section is not open', 'support.kb_section_unknown');
      throw new SupportError('KB article refused', result.reason === 'vendor' ? 'support.kb_vendor_name' : 'support.kb_invalid');
    }
    return toPublicKb(result.article);
  }

  /**
   * Publish an article typed in the desk (SP-kb-01). A blank title refuses `support.kb_title_blank`, a body that is
   * blank, too long or carries control characters `support.kb_body_invalid`. The section is checked by the caller.
   * The text is stored as typed (trimmed) and shown as text.
   */
  async publishKbText(input: {
    id: string;
    title: string;
    body: string;
    language: string;
    sectionId: string;
    tags?: readonly string[] | null;
    baseRevision: number;
  }): Promise<SupportKbArticle> {
    const titleProblem = supportKbTitleProblem(input.title);
    if (titleProblem) throw new SupportError('KB title refused', titleProblem);
    const bodyProblem = supportKbBodyProblem(input.body);
    if (bodyProblem) throw new SupportError('KB body refused', bodyProblem);
    // Readers see this text, so it is held to the same no-vendor rule as the catalogue keys.
    if (namesVendor(`${input.title} ${input.body} ${(input.tags ?? []).join(' ')}`)) {
      throw new SupportError('KB text must stay vendor-clean', 'support.kb_vendor_name');
    }
    const text = { title: input.title.trim(), body: input.body.trim(), language: input.language.trim(), sectionId: input.sectionId };
    try {
      return await this.publishKb({
        id: input.id,
        titleKey: SUPPORT_KB_STORED_TITLE_KEY,
        bodyKey: SUPPORT_KB_STORED_BODY_KEY,
        baseRevision: input.baseRevision,
        tags: input.tags ?? null,
        text,
      });
    } catch (err) {
      // A lost reply retried: the head is the version this same publish made from this same base, so it is the answer.
      if (!(err instanceof SupportError) || err.code !== 'support.kb.revision_stale') throw err;
      const versions = await this.store.listKbVersions(input.id);
      const head = versions[versions.length - 1];
      const tags = [...(input.tags ?? [])].map((tag) => tag.trim()).filter(Boolean);
      const same =
        head &&
        kbVersionOf(head) === input.baseRevision + 1 &&
        head.title === text.title &&
        head.body === text.body &&
        head.language === text.language &&
        head.sectionId === text.sectionId &&
        JSON.stringify(head.tags ?? []) === JSON.stringify(tags) &&
        (await this.store.getPublishedKb(input.id)) !== null;
      if (same) return toPublicKb({ ...head, published: true });
      throw err;
    }
  }

  /** Every published article the viewer may read, unpaged: what the library counts and a section page draws from. */
  async listKbVisible(viewer: SupportKbViewer = ANONYMOUS_KB_VIEWER): Promise<SupportKbArticle[]> {
    return this.visibleKb(await this.store.listPublishedKb({ audiences: audiencesFor(viewer) }), viewer).map(toPublicKb);
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
  async listOperatorQueue(
    options: { limit?: number; viewerId?: string; label?: string; filter?: unknown; sort?: unknown; q?: string } = {},
  ): Promise<QueueResult> {
    return withSupportSpan('support.listOperatorQueue', { op: 'listOperatorQueue' }, async () => {
      const limit = assertOperatorQueueLimit(options.limit);
      let tickets = await this.visibleTickets(options.viewerId, await this.store.listAll());
      if (options.label !== undefined) {
        if (!supportLabelSchema.safeParse(options.label).success) throw new SupportError('label is not valid', 'support.label_invalid');
        const carrying = await this.properties.ticketsWithLabel(options.label);
        tickets = tickets.filter((t) => carrying.has(t.id));
      }
      if (!this.deskQueryAsked(options)) return buildOperatorQueue(tickets, { limit });
      const facts = await this.narrow(await this.deskFacts(options.viewerId), { ...options, label: undefined });
      const allowed = new Set(tickets.map((ticket) => ticket.id));
      const visible = facts.filter((fact) => allowed.has(fact.ticket.id));
      const sort = this.deskSort(options.sort);
      // The queue's own ranking is score, highest first; any other order (score ascending too) is applied over it.
      if (sort && !(sort.key === 'score' && sort.dir === 'desc')) {
        const ranked = rankOperatorQueue(
          visible.map((fact) => fact.ticket),
          this.now(),
        );
        const byId = new Map(visible.map((fact) => [fact.ticket.id, fact]));
        const ordered = orderFacts(
          ranked.map((entry) => byId.get(entry.ticketId)).filter((fact): fact is DeskFact => fact !== undefined),
          sort,
          this.now(),
        );
        const page = ordered.slice(0, limit);
        if (page.length === 0) return { status: 'empty' };
        const entryById = new Map(ranked.map((entry) => [entry.ticketId, entry]));
        return { status: 'ok', entries: page.map((fact) => entryById.get(fact.ticket.id)!) };
      }
      return buildOperatorQueue(
        visible.map((fact) => fact.ticket),
        { limit, now: this.now() },
      );
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

  /**
   * Claim the queue's next request for this operator: the same ranking the queue shows, claimed atomically.
   * A row another operator took between the read and the claim is skipped, never stolen. An empty queue
   * refuses with `support.claim.queue_empty`.
   */
  async claimNext(operatorId: string): Promise<SupportTicket> {
    return withSupportSpan('support.claimNext', { op: 'claimNext' }, async (span) => {
      const skipped = new Set<string>();
      for (;;) {
        const tickets = await this.visibleTickets(operatorId, await this.store.listAll());
        const next = assignNext(tickets, { now: this.now(), excludeTicketIds: skipped });
        if (next === null) throw new SupportError('the queue has no request to claim', 'support.claim.queue_empty');
        const result = await this.store.claimTicket({ ticketId: next.ticketId, operatorId });
        if (result.status === 'ok') {
          span.setAttribute('intafaced.support.ticket_id', result.ticket.id);
          span.setAttribute('intafaced.support.assignee_id', operatorId);
          return result.ticket;
        }
        if (result.reason === 'invalid_operator')
          throw new SupportError('claim refused: invalid_operator', 'support.claim.invalid_operator');
        skipped.add(next.ticketId);
      }
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
  async listAllTicketsInScope(options: {
    limit?: number;
    viewerId: string;
    filter?: unknown;
    sort?: unknown;
    q?: string;
  }): Promise<SupportTicket[]> {
    return withSupportSpan('support.listAllTicketsInScope', { op: 'listAllTicketsInScope' }, async () => {
      const limit = assertListAllTicketsLimit(options.limit);
      if (!this.deskQueryAsked(options)) return (await this.visibleTickets(options.viewerId, await this.store.listAll())).slice(0, limit);
      const facts = orderFacts(await this.narrow(await this.deskFacts(options.viewerId), options), this.deskSort(options.sort), this.now());
      return facts.slice(0, limit).map((fact) => fact.ticket);
    });
  }

  /** Personal views of this person, plus every shared view. Caps are null while the owner has not set them. */
  async listDeskViews(viewerId: string): Promise<SupportViewList> {
    return {
      personalCap: viewCapWire(this.views.caps.personal, SUPPORT_VIEW_PERSONAL_CAP_KEY),
      sharedCap: viewCapWire(this.views.caps.shared, SUPPORT_VIEW_SHARED_CAP_KEY),
      views: await this.views.listVisible(viewerId),
    };
  }

  /**
   * Save a view under the caller's id. A shared view needs a lead. Someone else's view is `support.view_not_owner`
   * when they can see it, and not-found when they cannot. A blank cap refuses; a full cap refuses without adding a row.
   */
  async saveDeskView(input: {
    actorId: string;
    viewId?: string;
    name: string;
    expectedRevision: number;
    shared: boolean;
    filter?: unknown;
    sort?: unknown;
    layout?: unknown;
    favourite?: boolean;
    reason: string;
  }): Promise<SupportView> {
    if (input.filter === undefined) throw new SupportError('filter is missing', 'support.filter_invalid');
    const filter = this.deskFilter(input.filter);
    const sort = this.deskSort(input.sort);
    let layout: string | null;
    try {
      layout = parseLayout(input.layout);
    } catch (err) {
      throw this.viewFailure(err);
    }
    if (input.viewId) {
      const existing = await this.views.get(input.viewId);
      if (!existing || existing.ownerId !== input.actorId) {
        throw new SupportError('view not found', existing?.shared ? 'support.view_not_owner' : 'support.not_found');
      }
    }
    if (input.shared) await this.requireLead(input.actorId, 'only a lead can share a view');
    try {
      return await this.views.save({
        ...(input.viewId ? { viewId: input.viewId } : {}),
        name: input.name,
        ownerId: input.actorId,
        expectedRevision: input.expectedRevision,
        shared: input.shared,
        filter,
        sort,
        layout,
        favourite: input.favourite === true,
        reason: input.reason,
        at: this.now().toISOString(),
      });
    } catch (err) {
      throw this.viewFailure(err);
    }
  }

  async deleteDeskView(input: { actorId: string; viewId: string; reason: string }): Promise<SupportView> {
    const existing = await this.views.get(input.viewId);
    // A retried delete whose first answer was lost answers with the view it deleted.
    if (!existing) {
      const replay = await this.views.deleted({ viewId: input.viewId, actorId: input.actorId, reason: input.reason });
      if (replay) return replay;
    }
    if (!existing || existing.ownerId !== input.actorId) {
      throw new SupportError('view not found', existing?.shared ? 'support.view_not_owner' : 'support.not_found');
    }
    try {
      return await this.views.remove({ viewId: input.viewId, actorId: input.actorId, reason: input.reason, at: this.now().toISOString() });
    } catch (err) {
      throw this.viewFailure(err);
    }
  }

  /** How many tickets this caller may see match each view they may open. The count is the whole match, not one page. */
  async deskViewCounts(viewerId: string): Promise<{ viewId: string; count: number }[]> {
    const [views, facts] = await Promise.all([this.views.listVisible(viewerId), this.deskFacts(viewerId)]);
    return views.map((view) => ({ viewId: view.id, count: facts.filter((fact) => filterMatches(view.filter as DeskFilter, fact)).length }));
  }

  private deskQueryAsked(options: { filter?: unknown; sort?: unknown; q?: string }): boolean {
    return options.filter !== undefined || (options.sort !== undefined && options.sort !== null) || Boolean(options.q?.trim());
  }

  private deskFilter(raw: unknown): DeskFilter {
    try {
      return parseDeskFilter(raw);
    } catch (err) {
      throw this.viewFailure(err);
    }
  }

  private deskSort(raw: unknown): SupportViewSort | null {
    try {
      return parseDeskSort(raw);
    } catch (err) {
      throw this.viewFailure(err);
    }
  }

  private viewFailure(err: unknown): Error {
    if (err instanceof ViewError) return new SupportError(err.code, err.code, err.missingKey);
    if (err instanceof SupportError) return err;
    return err instanceof Error ? err : new Error(String(err));
  }

  private async deskFacts(viewerId: string | undefined): Promise<DeskFact[]> {
    const tickets = await this.visibleTickets(viewerId, await this.store.listAll());
    const grouped = await this.groups.groupedTickets();
    const facts: DeskFact[] = [];
    for (const ticket of tickets) {
      const [props, life] = await Promise.all([this.properties.get(ticket.id), this.lifecycle.get(ticket.id)]);
      facts.push({
        ticket,
        priority: props.priority,
        ticketType: props.ticketType,
        labels: props.labels,
        groupId: grouped.get(ticket.id) ?? null,
        waitingOn: life.waitingOn,
      });
    }
    return facts;
  }

  private async narrow(facts: DeskFact[], options: { filter?: unknown; q?: string; label?: string }): Promise<DeskFact[]> {
    const filter = options.filter === undefined ? null : this.deskFilter(options.filter);
    const needle = options.q?.trim() ?? '';
    return facts.filter((fact) => (filter === null || filterMatches(filter, fact)) && (needle === '' || searchHits(fact.ticket, needle)));
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
   * What agents changed on a ticket's priority, type and labels, oldest first: one entry per field per save, with
   * who, why and when (SP-tickets-04). Staff only, like the properties themselves; the ticket's own trail stays the
   * owner's view.
   */
  async listTicketPropertyChanges(input: { operatorId: string; ticketId: string; limit: number }): Promise<SupportTicketPropertyChange[]> {
    await this.assertDeskVisible(input.operatorId, input.ticketId);
    if (!(await this.store.findById(input.ticketId))) throw ticketNotFound();
    return this.properties.changes(input.ticketId, input.limit);
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
    /**
     * The last trail row the operator had read: a newer row by someone else refuses `support.stale_ticket` and nothing is
     * written. Checked after a replay, so the same request id answers its first result. The property log keeps no ticket
     * lock, so this is a read just before the write, not a lock.
     */
    expectedSequence?: number;
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
        if (input.expectedSequence !== undefined) {
          const newer = newerByOthers(await this.store.listEvents(input.ticketId), input.expectedSequence, input.operatorId);
          if (newer.length > 0) throw staleTicket(newer);
        }
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

  /**
   * The staff directory: each member with the desk groups (teams) they belong to,
   * read from the group book (SP-agents-01 with SP-desk-04). Groups are sorted by
   * name; a member in no group carries an empty list, never an invented team.
   */
  async listStaffDirectory(): Promise<(StaffMember & { groups: { id: string; name: string }[] })[]> {
    const [members, groups] = await Promise.all([this.listStaff(), this.groups.list()]);
    // One pass over the groups (already sorted by name) builds user id -> groups, so the directory stays linear.
    const byUser = new Map<string, { id: string; name: string }[]>();
    for (const g of groups) {
      for (const userId of g.memberIds) {
        const list = byUser.get(userId);
        if (list) list.push({ id: g.id, name: g.name });
        else byUser.set(userId, [{ id: g.id, name: g.name }]);
      }
    }
    return members.map((member) => ({ ...member, groups: byUser.get(member.userId) ?? [] }));
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

  /** What a bulk change may hold: the owner's batch size, or `null` and the key it is missing while it is not set. */
  bulkPolicy(): SupportBulkPolicy {
    return this.bulkCap === null ? { cap: null, missing: SUPPORT_BULK_CAP_KEY } : { cap: this.bulkCap, missing: null };
  }

  /**
   * One change applied to several requests, each through the path a single change takes and under its own key
   * (`bulk:<batchKey>:<ticketId>`), so each writes its own trail row and a replayed batch changes nothing twice.
   * A request the change does not apply to is reported `refused` with its typed code and the rest still run; one
   * already at the asked status is `unchanged`. A blank cap refuses the whole batch `support.bulk_cap_unset`, a batch
   * over the cap refuses `support.bulk_too_large`, and neither touches a request. Assigning needs a lead, so it is
   * refused once up front and not once per request.
   */
  async bulkUpdate(input: {
    operatorId: string;
    batchKey: string;
    ticketIds: readonly string[];
    change: SupportBulkChange;
    reason?: string;
  }): Promise<SupportBulkResult> {
    return withSupportSpan('support.bulkUpdate', { op: 'bulkUpdate' }, async (span) => {
      if (this.bulkCap === null) {
        throw new SupportError('the bulk batch size is not set', 'support.bulk_cap_unset', SUPPORT_BULK_CAP_KEY);
      }
      const ticketIds = [...new Set(input.ticketIds)];
      if (ticketIds.length > this.bulkCap) {
        throw new SupportError('the batch is larger than the desk allows', 'support.bulk_too_large');
      }
      if (input.change.kind === 'assign') {
        const actor = await this.staff.get(input.operatorId);
        if (actor?.role !== 'lead') throw new SupportError('only a lead can assign a ticket', 'support.not_lead');
      }
      span.setAttribute('intafaced.support.bulk_size', ticketIds.length);
      const results: SupportBulkResult['results'] = [];
      for (const ticketId of ticketIds) {
        const key = supportBulkKey(input.batchKey, ticketId);
        try {
          await this.bulkOne({ operatorId: input.operatorId, ticketId, key, change: input.change, reason: input.reason });
          results.push({ ticketId, outcome: 'changed', code: null });
        } catch (err) {
          if (!(err instanceof SupportError)) throw err;
          const unchanged = input.change.kind === 'status' && err.code === 'support.transition_same_status';
          results.push({ ticketId, outcome: unchanged ? 'unchanged' : 'refused', code: unchanged ? null : err.code });
        }
      }
      return { batchKey: input.batchKey, results };
    });
  }

  private async bulkOne(input: {
    operatorId: string;
    ticketId: string;
    key: string;
    change: SupportBulkChange;
    reason: string | undefined;
  }): Promise<void> {
    const { operatorId, ticketId, key, change, reason } = input;
    if (change.kind === 'status') {
      // Only an answer is kept: a request that was changed, or found already at the status. A refusal changed nothing,
      // so a retry judges it afresh and never meets a half-recorded key.
      const stateKey = `bulk-status:${key}`;
      const fingerprint = `${operatorId}:${ticketId}:${change.status}`;
      try {
        await this.staff.begin(stateKey, fingerprint);
      } catch (err) {
        if (err instanceof Error && err.message === 'support.idempotency_conflict') {
          throw new SupportError('idempotency key was already used for a different command', 'support.idempotency_conflict');
        }
        throw err;
      }
      const prior = await this.staff.read<{ outcome: 'changed' | 'unchanged' }>(stateKey);
      if (prior?.outcome === 'changed') return;
      if (prior?.outcome === 'unchanged') {
        throw new SupportError('the request is already at that status', 'support.transition_same_status');
      }
      try {
        await this.setStatus({ operatorId, ticketId, status: change.status, ...(reason ? { note: reason } : {}) });
      } catch (err) {
        if (err instanceof SupportError && err.code === 'support.transition_same_status') {
          await this.staff.save(stateKey, { outcome: 'unchanged' });
        }
        throw err;
      }
      await this.staff.save(stateKey, { outcome: 'changed' });
    } else if (change.kind === 'assign') {
      await this.assignTo({ operatorId, ticketId, assigneeId: change.assigneeId, idempotencyKey: key });
    } else {
      await this.setTicketProperties({
        operatorId,
        ticketId,
        priority: change.priority,
        ...(reason ? { reason } : {}),
        clientRequestId: key,
      });
    }
  }

  /**
   * Fold a duplicate request into the one that stays (SP-tickets-07). Irreversible. Both requests must be below resolved
   * and held by one requester account (no sharing concept exists, so a merge never puts a customer's messages under
   * someone else's request). The move and the trail rows are one store transaction; a replay of (source, survivor)
   * returns the stored result. A rating or an escalation case file stays on the source.
   */
  async mergeTickets(input: { operatorId: string; sourceId: string; survivorId: string; reason: string }): Promise<SupportMergeResult> {
    return withSupportSpan('support.mergeTickets', { op: 'mergeTickets', ticketId: input.sourceId }, async () => {
      if (input.sourceId === input.survivorId) {
        throw new SupportError('a request cannot be merged into itself', 'support.merge_same_ticket');
      }
      await this.assertDeskVisible(input.operatorId, input.sourceId);
      await this.assertDeskVisible(input.operatorId, input.survivorId);
      const result = await this.store.mergeTickets(input);
      if (result.status === 'refuse') {
        if (result.reason === 'not_found') throw ticketNotFound();
        throw new SupportError('these requests cannot be merged', 'support.merge_not_allowed');
      }
      const { merge } = result;
      return {
        sourceId: merge.sourceId,
        survivorId: merge.survivorId,
        commentsMoved: merge.commentsMoved,
        attachmentsMoved: merge.attachmentsMoved,
        mergedAt: merge.mergedAt,
      };
    });
  }

  /** What a merge would move and what stays, for the confirmation. Reads only; moves nothing. */
  async previewMerge(input: { operatorId: string; sourceId: string; survivorId: string }): Promise<SupportMergePreview> {
    return withSupportSpan('support.previewMerge', { op: 'previewMerge', ticketId: input.sourceId }, async () => {
      await this.assertDeskVisible(input.operatorId, input.sourceId);
      await this.assertDeskVisible(input.operatorId, input.survivorId);
      const same = input.sourceId === input.survivorId;
      const result = same ? null : await this.store.previewMerge(input);
      if (result?.status === 'refuse') throw ticketNotFound();
      const refusal = same
        ? ('support.merge_same_ticket' as const)
        : result && (result.allowed || result.alreadyMerged)
          ? null
          : ('support.merge_not_allowed' as const);
      return {
        sourceId: input.sourceId,
        survivorId: input.survivorId,
        refusal,
        commentsToMove: result?.commentsToMove ?? 0,
        attachmentsToMove: result?.attachmentsToMove ?? 0,
        staysOnSource: { rating: result?.ratingStays ?? false, caseFile: result?.caseFileStays ?? false },
        alreadyMerged: result?.alreadyMerged ?? false,
      };
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
    return this.attachFile(input);
  }

  /**
   * Operator attach. The assigned operator adds a file to the ticket for its owner: the file belongs to the owner, who
   * sees it like a comment, and `uploadedBy` names the operator. Same limits, scanner and store as the owner's attach; a
   * ticket that is not the operator's answers like no ticket.
   */
  async attachAsOperator(input: {
    operatorId: string;
    ticketId: string;
    clientRequestId: string;
    contentType: string;
    bodyBase64: string;
  }): Promise<AttachmentMeta> {
    const ticket = await this.store.findById(input.ticketId);
    if (!ticket || ticket.assigneeId !== input.operatorId) throw ticketNotFound();
    const { operatorId, ...rest } = input;
    return this.attachFile({ ...rest, userId: ticket.userId, operatorId });
  }

  private async attachFile(input: {
    userId: string;
    ticketId: string;
    clientRequestId: string;
    contentType: string;
    bodyBase64: string;
    operatorId?: string;
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
      const actor = input.operatorId ?? input.userId;
      const replay = await this.store.readReceipt('support.attach', actor, input.clientRequestId);
      if (replay && typeof replay === 'object' && replay !== null && 'attachment' in replay) {
        // A reply that was lost is answered from the file as it now stands, never scanned or counted a second time.
        const first = (replay as { attachment: AttachmentMeta }).attachment;
        const live = await this.store.readAttachment({ userId: actor, attachmentId: first.id, asOperator: input.operatorId !== undefined });
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
        ...(input.operatorId !== undefined ? { operatorId: input.operatorId } : {}),
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
   * Scans a file that is `scanning` and records the answer. The final key is written only after a clean verdict, so
   * infected bytes are never stored under it. When the scanner cannot answer, the bytes wait under a held key
   * (`held/<storeKey>`) that nothing serves, the row stays `scanning`, and the caller is told
   * `support.attachment_scan_unknown`. A clean verdict writes the final key, drops the held copy, and marks the row; if the
   * row was blocked in the meantime, the final key is purged and the file is refused. An infected verdict blocks the row
   * and purges any held copy. A crash between the write and the mark leaves a `scanning` row that a later pass settles.
   */
  private async settleScan(desk: AttachmentDesk, meta: AttachmentMeta, bytes: Uint8Array): Promise<AttachmentMeta> {
    let verdict: ScanVerdict;
    try {
      verdict = await desk.scanner!.scan(bytes);
    } catch {
      verdict = 'unknown';
    }
    const held = heldKey(meta.storeKey);
    if (verdict === 'infected') {
      await this.store.setAttachmentScanState({ attachmentId: meta.id, state: 'blocked' });
      await desk.store!.delete(held);
      await desk.store!.delete(meta.storeKey);
      throw scanRefused();
    }
    if (verdict !== 'clean') {
      await desk.store!.put({ key: held, bytes, contentType: meta.contentType });
      throw new SupportError('the scanner could not say whether the attachment is safe', 'support.attachment_scan_unknown');
    }
    await desk.store!.put({ key: meta.storeKey, bytes, contentType: meta.contentType });
    const settled = await this.store.setAttachmentScanState({ attachmentId: meta.id, state: 'clean' });
    if (!settled) {
      await desk.store!.delete(meta.storeKey);
      throw ticketNotFound();
    }
    if (settled.scanState === 'blocked') {
      await desk.store!.delete(meta.storeKey);
      await desk.store!.delete(held);
      throw scanRefused();
    }
    await desk.store!.delete(held);
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
      // Bytes a crash left under the final key were never marked clean, so they are scanned again like held ones.
      const object = (await desk.store!.get(heldKey(meta.storeKey))) ?? (await desk.store!.get(meta.storeKey));
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
    comment?: string;
    openRequest?: boolean;
  }): Promise<KbFeedbackVote> {
    // The owner's vote rate binds an account too: blank refuses and stores nothing.
    return this.recordFeedback({ ...input, rate: this.feedbackRate() });
  }

  private feedbackRate(): { limit: number; windowSeconds: number } | 'unset' {
    const limit = this.kbDesk.feedbackRateLimit;
    const windowSeconds = this.kbDesk.feedbackRateWindowSeconds;
    return limit != null && windowSeconds != null ? { limit, windowSeconds } : 'unset';
  }

  /**
   * A signed-out vote, keyed by the browser's reader token. The rate is an owner
   * value: blank refuses and stores nothing. The token is not an account and is
   * not returned.
   */
  async kbFeedbackPublic(input: {
    readerToken: string;
    id: string;
    helpful: boolean;
    clientRequestId: string;
  }): Promise<{ articleId: string; version: number; helpful: boolean }> {
    const vote = await this.recordFeedback({
      userId: readerActorId(input.readerToken),
      id: input.id,
      helpful: input.helpful,
      clientRequestId: input.clientRequestId,
      viewer: ANONYMOUS_KB_VIEWER,
      rate: this.feedbackRate(),
    });
    return { articleId: vote.articleId, version: vote.version, helpful: vote.helpful };
  }

  /** Counts per article version for the desk. No reader id. */
  async kbFeedbackSummary(input: { limit?: number } = {}): Promise<KbFeedbackCount[]> {
    const limit = assertListKbLimit(input.limit);
    return this.store.listKbFeedbackSummary(limit);
  }

  /** Searches that found nothing, newest first. The rows have no reader. */
  async kbSearchMisses(input: { limit?: number } = {}): Promise<KbSearchMiss[]> {
    const limit = assertListKbLimit(input.limit);
    return this.store.listSearchMisses(limit);
  }

  /**
   * A click on a result the caller may see. A hidden article is not recorded and
   * answers like a miss. The same request id records one click.
   */
  async kbSearchClick(input: {
    articleId: string;
    query: string;
    clientRequestId: string;
    viewer?: SupportKbViewer;
  }): Promise<{ recorded: boolean }> {
    this.requireClientRequestId(input.clientRequestId);
    const q = input.query.trim();
    if (
      q.length === 0 ||
      q.length > SEARCH_QUERY_CONTRACT_MAX ||
      (this.kbDesk.searchQueryMax != null && q.length > this.kbDesk.searchQueryMax)
    ) {
      throw new SupportError('search query is longer than the maximum', SUPPORT_SEARCH_QUERY_TOO_LONG);
    }
    if (await this.store.hasSearchClick(input.clientRequestId)) return { recorded: true };
    const viewer = input.viewer ?? ANONYMOUS_KB_VIEWER;
    const article = await this.store.getPublishedKb(input.articleId);
    if (!article || !kbAudienceVisibleTo(article.audience, viewer)) return { recorded: false };
    await this.store.recordSearchClick({
      query: q,
      articleId: input.articleId,
      clientRequestId: input.clientRequestId,
      at: this.now().toISOString(),
    });
    return { recorded: true };
  }

  /**
   * The answer panel. A blank model refuses and builds nothing. When the owner
   * has set one, the answer is the ranked articles themselves: this service
   * calls no model and returns no provider name.
   */
  async kbAnswer(query: string, options: { limit?: number; viewer?: SupportKbViewer } = {}): Promise<{ sources: SupportKbArticle[] }> {
    if (!this.kbDesk.assistantModel?.trim()) {
      throw new SupportError('the assistant model is not set', SUPPORT_ASSISTANT_MODEL_UNSET);
    }
    return { sources: await this.searchKb(query, options) };
  }

  private async recordFeedback(input: {
    userId: string;
    id: string;
    helpful: boolean;
    clientRequestId: string;
    viewer?: SupportKbViewer;
    comment?: string;
    openRequest?: boolean;
    rate?: { limit: number; windowSeconds: number } | 'unset';
  }): Promise<KbFeedbackVote> {
    return withSupportSpan('support.kbFeedback', { op: 'kbFeedback' }, async () => {
      this.requireClientRequestId(input.clientRequestId);
      // A blank owner rate refuses every vote, a repeat of an earlier one too: rating is switched off.
      if (input.rate === 'unset') throw new SupportError('the feedback rate limit is not set', SUPPORT_FEEDBACK_RATE_LIMIT_UNSET);
      const comment = input.comment?.trim() ?? '';
      if (comment.length > FEEDBACK_COMMENT_MAX) {
        throw new SupportError('feedback comment is too long', 'support.feedback_comment_too_long');
      }
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
        comment: comment || null,
        openRequest: input.openRequest === true,
        ...(input.rate !== undefined ? { rate: input.rate } : {}),
        now: this.now().toISOString(),
      });
      if (result.status === 'refuse') {
        if (result.reason === 'rate_unset') throw new SupportError('the feedback rate limit is not set', SUPPORT_FEEDBACK_RATE_LIMIT_UNSET);
        if (result.reason === 'rate_exceeded') throw new SupportError('the feedback rate limit is reached', SUPPORT_FEEDBACK_RATE_EXCEEDED);
        if (result.reason === 'request_invalid') {
          throw new SupportError('an article request needs an unhelpful vote and a comment', SUPPORT_FEEDBACK_REQUEST_INVALID);
        }
        throw new SupportError('article is not published', 'support.kb.not_published');
      }
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
