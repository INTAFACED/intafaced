import 'server-only';
import {
  supportAccountGroundingSchema,
  supportCaseFileSchema,
  supportCommentSchema,
  supportKbArticleSchema,
  supportMergeResultSchema,
  supportTicketEventSchema,
  supportTicketLifecycleSchema,
  supportTicketPropertiesSchema,
  supportTicketPropertyChangeSchema,
  supportTicketSchema,
  supportViewCountsSchema,
  supportViewListSchema,
  supportViewSchema,
} from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY } from './refusal';
import { QUEUE_PAGE, readQueueResult, readRatingResult, type SupportActionRequest } from './model';
import { EMPTY_QUERY, isQueryEmpty, type QueueQuery } from './queue-query';
import { readBulkPolicy, readBulkResults } from './bulk';
import { readMergePreview } from './merge';
import { readRatingSummary } from './ratings';
import { readDeskScope, readGroup, readGroups } from './groups';
import { readStaffMember, readStaffPolicy, readStaffRoster } from './staff';
import type {
  SupportKbView,
  SupportLifecycleView,
  SupportPropertiesView,
  SupportRatingSummaryView,
  SupportBulkPolicyView,
  SupportQueueView,
  SupportGroupsView,
  SupportStaffView,
  SupportCustomerView,
  SupportTicketView,
  SupportViewsView,
  TicketExtrasView,
} from './types';

/**
 * svc-support's operator desk, read and used as the signed-in founder.
 *
 * Every procedure here is `support:ops`. Founder sign-in does not carry that permission today, so svc-support will
 * refuse with 403 until identity grants it (admin-BACKEND-NEEDS.md); the desk then says exactly that. Claiming
 * assigns the ticket to the founder who pressed the button: svc-support takes the operator id from the verified
 * session, never from this console.
 */

const LABELS: PartLabels = {
  service: 'svc-support',
  forbiddenMessage: `${SUPPORT_OPS_FORBIDDEN}. ${SUPPORT_OPS_FORBIDDEN_BODY}`,
};

const arrayOf =
  <T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }) =>
  (raw: unknown): T[] | null => {
    if (!Array.isArray(raw)) return null;
    const out: T[] = [];
    for (const row of raw) {
      const parsed = schema.safeParse(row);
      if (!parsed.success) return null;
      out.push(parsed.data);
    }
    return out;
  };

const readQueuePage = (raw: unknown) => readQueueResult(raw, QUEUE_PAGE);

/** svc-support names its refusal in the cause, or as the whole message. */
const refusalCode = (r: { code: string | null; message: string }): string | null =>
  r.code ?? (/^support\.[a-z_.]+$/.test(r.message) ? r.message : null);

/**
 * The queue, narrowed by the address's filter, search or saved view (SP-desk-01). svc-support judges the filter: when it
 * refuses one, the page shows that refusal by name beside the plain queue, never an empty list that reads as "none".
 */
export async function loadQueue(
  ctx: FounderCallContext,
  asked: QueueQuery = EMPTY_QUERY,
  now: Date = new Date(),
): Promise<SupportQueueView> {
  const asOf = now.toISOString();
  let query = asked;
  const plain = () => founderCall(ctx, 'support', 'listQueue', 'GET', { limit: QUEUE_PAGE }, readQueuePage);
  if (isQueryEmpty(query)) return { asOf, queue: partFrom(await plain(), (d) => d, LABELS), query };

  let filter: unknown = query.filter ?? undefined;
  let sort: unknown = undefined;
  let view: SupportQueueView['view'] = null;
  if (query.viewId) {
    const views = await founderCall(ctx, 'support', 'viewsList', 'GET', {}, parseWith(supportViewListSchema));
    const found = views.kind === 'ok' ? (views.data.views.find((v) => v.id === query.viewId) ?? null) : null;
    if (!found) {
      const code = views.kind === 'ok' ? 'admin.support_view_not_found' : views.kind;
      return { asOf, queue: partFrom(await plain(), (d) => d, LABELS), query, refused: { what: 'view', code, field: null } };
    }
    const mine = found.ownerId.toLowerCase() === ctx.session.userId.toLowerCase();
    view = { id: found.id, name: found.name, shared: found.shared, ownerId: found.ownerId, mine };
    // A saved view is its own filter and order; a filter also in the address is not applied.
    filter = found.filter;
    sort = found.sort ?? undefined;
    query = { ...query, filter: null };
  }
  const input = {
    limit: QUEUE_PAGE,
    ...(filter !== undefined ? { filter } : {}),
    ...(sort !== undefined ? { sort } : {}),
    ...(query.q ? { q: query.q } : {}),
  };
  const result = await founderCall(ctx, 'support', 'listQueue', 'GET', input, readQueuePage);
  if (result.kind === 'refused') {
    const code = refusalCode(result.refusal);
    // Named by what svc-support refused: only `support.filter_invalid` is about a typed filter's field.
    const what = view ? 'view' : code === 'support.filter_invalid' && query.filter ? 'filter' : 'search';
    return {
      asOf,
      queue: partFrom(await plain(), (d) => d, LABELS),
      query,
      view,
      refused: { what, code, field: what === 'filter' ? (query.filter?.field ?? null) : null },
    };
  }
  return { asOf, queue: partFrom(result, (d) => d, LABELS), query, view };
}

/** The saved views this founder may open, with one count each. Two reads, each its own part. */
export async function loadViews(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportViewsView> {
  const [list, counts] = await Promise.all([
    founderCall(ctx, 'support', 'viewsList', 'GET', {}, parseWith(supportViewListSchema)),
    founderCall(ctx, 'support', 'viewsCounts', 'GET', {}, parseWith(supportViewCountsSchema)),
  ]);
  return {
    asOf: now.toISOString(),
    meId: ctx.session.userId,
    list: partFrom(list, (l) => l, LABELS),
    counts: partFrom(counts, (c) => c.counts, LABELS),
  };
}

export async function loadTicket(ctx: FounderCallContext, ticketId: string, now: Date = new Date()): Promise<SupportTicketView> {
  const [ticket, comments, events, propertyChanges] = await Promise.all([
    founderCall(ctx, 'support', 'get', 'GET', { ticketId }, parseWith(supportTicketSchema)),
    founderCall(ctx, 'support', 'listComments', 'GET', { ticketId, limit: 100 }, arrayOf(supportCommentSchema)),
    founderCall(ctx, 'support', 'events', 'GET', { ticketId, limit: 100 }, arrayOf(supportTicketEventSchema)),
    founderCall(ctx, 'support', 'ticketPropertyHistory', 'GET', { ticketId, limit: 100 }, arrayOf(supportTicketPropertyChangeSchema)),
  ]);
  const detail = partFrom(
    ticket,
    (t) => ({
      ticket: t,
      comments: partFrom(comments, (c) => c, LABELS),
      events: partFrom(events, (e) => e, LABELS),
      propertyChanges: partFrom(propertyChanges, (c) => c, LABELS),
    }),
    LABELS,
  );
  return { asOf: now.toISOString(), detail };
}

/**
 * Claim the request svc-support ranks first. svc-support's `next` only peeks, so another agent can claim the same one
 * between the peek and the claim; that claim is refused and the next one is tried, a few times at most. `empty` is
 * svc-support's own answer that nothing is waiting.
 */
export async function claimNextTicket(
  ctx: FounderCallContext,
  tries = 3,
): Promise<FounderCallResult<ReturnType<typeof supportTicketSchema.parse>> | { readonly kind: 'empty' }> {
  let last: FounderCallResult<ReturnType<typeof supportTicketSchema.parse>> | null = null;
  for (let i = 0; i < tries; i += 1) {
    const next = await founderCall(ctx, 'support', 'next', 'GET', undefined, (raw) => {
      if (raw === null) return { ticketId: null };
      const id = (raw as { ticketId?: unknown } | null)?.ticketId;
      return typeof id === 'string' ? { ticketId: id } : null;
    });
    if (next.kind !== 'ok') return next;
    if (next.data.ticketId === null) return { kind: 'empty' };
    last = await claimTicket(ctx, next.data.ticketId);
    // Taken by someone else in between: try the next one. Anything else is the answer.
    if (!(last.kind === 'refused' && /^support\.claim\.(already_claimed|not_queueable)$/.test(last.refusal.code ?? last.refusal.message)))
      return last;
  }
  return last!;
}

/**
 * The customer card: the account's state as svc-identity says it through svc-support (the read is recorded on the
 * ticket's history), and the order the request is about. A request names no order today (its form has no order field),
 * so the related order is "none" from the ticket itself, never a guess.
 */
export async function loadCustomerCard(ctx: FounderCallContext, ticketId: string, now: Date = new Date()): Promise<SupportCustomerView> {
  const state = await founderCall(ctx, 'support', 'accountState', 'GET', { ticketId }, parseWith(supportAccountGroundingSchema));
  return { asOf: now.toISOString(), account: partFrom(state, (s) => s, LABELS), relatedOrderId: null };
}

export function claimTicket(
  ctx: FounderCallContext,
  ticketId: string,
): Promise<FounderCallResult<ReturnType<typeof supportTicketSchema.parse>>> {
  return founderCall(ctx, 'support', 'claim', 'POST', { ticketId }, parseWith(supportTicketSchema));
}

/**
 * The operator-only reads on one ticket: the case file an escalation was made against, and the customer's rating.
 * Both are `support:ops`. Each is its own part: a refusal on one is shown as that part's refusal, never as "none".
 */
export async function loadTicketExtras(ctx: FounderCallContext, ticketId: string, now: Date = new Date()): Promise<TicketExtrasView> {
  const [caseFile, rating] = await Promise.all([
    founderCall(ctx, 'support', 'caseFile', 'GET', { ticketId }, (raw) => {
      // founderCall reads a null parse as "unreadable", but null is the service's real answer for "never escalated". Box it.
      const parsed = supportCaseFileSchema.nullable().safeParse(raw);
      return parsed.success ? { value: parsed.data } : null;
    }),
    founderCall(ctx, 'support', 'ratingOps', 'GET', { ticketId }, (raw) => readRatingResult(raw)),
  ]);
  return {
    asOf: now.toISOString(),
    caseFile: partFrom(caseFile, (c) => c.value, LABELS),
    rating: partFrom(rating, (r) => r.value, LABELS),
  };
}

/** Priority, type and labels on one ticket. Its own read, so a refusal here never hides the ticket. */
export async function loadTicketProperties(
  ctx: FounderCallContext,
  ticketId: string,
  now: Date = new Date(),
): Promise<SupportPropertiesView> {
  const result = await founderCall(ctx, 'support', 'ticketProperties', 'GET', { ticketId }, parseWith(supportTicketPropertiesSchema));
  return { asOf: now.toISOString(), properties: partFrom(result, (p) => p, LABELS) };
}

/** Who a ticket waits on and the request it follows. Its own read, so a refusal here never hides the ticket. */
export async function loadTicketLifecycle(
  ctx: FounderCallContext,
  ticketId: string,
  now: Date = new Date(),
): Promise<SupportLifecycleView> {
  const result = await founderCall(ctx, 'support', 'ticketLifecycle', 'GET', { ticketId }, parseWith(supportTicketLifecycleSchema));
  return { asOf: now.toISOString(), lifecycle: partFrom(result, (l) => l, LABELS) };
}

/** Ratings for the requests solved in the stated window. Its own read, so a refusal here never hides the queue. */
export async function loadRatingSummary(
  ctx: FounderCallContext,
  window: { readonly from: string; readonly to: string },
  now: Date = new Date(),
): Promise<SupportRatingSummaryView> {
  const result = await founderCall(ctx, 'support', 'ratingSummary', 'GET', { from: window.from, to: window.to }, readRatingSummary);
  return { asOf: now.toISOString(), summary: partFrom(result, (r) => r, LABELS) };
}

/** Who is on the support staff and whether automatic offline is set. Two reads, each its own part. */
export async function loadStaff(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportStaffView> {
  const [roster, policy] = await Promise.all([
    founderCall(ctx, 'support', 'staffList', 'GET', {}, readStaffRoster),
    founderCall(ctx, 'support', 'staffAvailabilityPolicy', 'GET', {}, readStaffPolicy),
  ]);
  return {
    asOf: now.toISOString(),
    meId: ctx.session.userId,
    roster: partFrom(roster, (r) => r, LABELS),
    policy: partFrom(policy, (p) => p, LABELS),
  };
}

/** Desk groups, this person's own scope and the roster. Three reads, each its own part. */
export async function loadGroups(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportGroupsView> {
  const [groups, scope, roster] = await Promise.all([
    founderCall(ctx, 'support', 'groupsList', 'GET', {}, readGroups),
    founderCall(ctx, 'support', 'deskScope', 'GET', {}, readDeskScope),
    founderCall(ctx, 'support', 'staffList', 'GET', {}, readStaffRoster),
  ]);
  return {
    asOf: now.toISOString(),
    meId: ctx.session.userId,
    groups: partFrom(groups, (g) => g, LABELS),
    scope: partFrom(scope, (x) => x, LABELS),
    roster: partFrom(roster, (r) => r, LABELS),
  };
}

/** Published help articles, with the revision a publish or unpublish must quote. svc-support lists no unpublished ones. */
export async function loadKb(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportKbView> {
  const result = await founderCall(ctx, 'support', 'listKb', 'GET', { limit: 100 }, arrayOf(supportKbArticleSchema));
  return { asOf: now.toISOString(), articles: partFrom(result, (a) => a, LABELS) };
}

/** What a merge of one request into another would move, for the confirmation. Reads only; a refusal is returned as it is. */
export async function previewMerge(ctx: FounderCallContext, sourceId: string, survivorId: string) {
  return founderCall(ctx, 'support', 'previewMerge', 'GET', { sourceId, survivorId }, readMergePreview);
}

/** The owner's bulk batch size, or `cap: null` while it is not set. A failed read is the part's failure, never a number. */
export async function loadBulkPolicy(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportBulkPolicyView> {
  const result = await founderCall(ctx, 'support', 'bulkPolicy', 'GET', {}, readBulkPolicy);
  return { asOf: now.toISOString(), policy: partFrom(result, (p) => p, LABELS) };
}

/**
 * One desk write, as the signed-in founder. svc-support takes the operator id from the verified session, so a reply,
 * a status change or an escalation is recorded against the person at the keyboard.
 */
export function runSupportAction(ctx: FounderCallContext, request: SupportActionRequest): Promise<FounderCallResult<unknown>> {
  switch (request.action) {
    case 'reply':
      return founderCall(
        ctx,
        'support',
        'comment',
        'POST',
        {
          ticketId: request.ticketId,
          body: request.body,
          ...(request.seenEventSequence !== undefined ? { seenEventSequence: request.seenEventSequence } : {}),
        },
        parseWith(supportCommentSchema),
      );
    case 'status':
      return founderCall(
        ctx,
        'support',
        'setStatus',
        'POST',
        { ticketId: request.ticketId, status: request.status, ...(request.note ? { note: request.note } : {}) },
        parseWith(supportTicketSchema),
      );
    case 'escalate':
      return founderCall(
        ctx,
        'support',
        'escalate',
        'POST',
        {
          ticketId: request.ticketId,
          reason: request.reason,
          summary: request.summary,
          ...(request.citedArticleIds ? { citedArticleIds: request.citedArticleIds } : {}),
        },
        parseWith(supportCaseFileSchema),
      );
    case 'group_save':
      return founderCall(
        ctx,
        'support',
        'groupsSave',
        'POST',
        { name: request.name, idempotencyKey: request.idempotencyKey, ...(request.groupId ? { groupId: request.groupId } : {}) },
        readGroup,
      );
    case 'group_member':
      return founderCall(
        ctx,
        'support',
        request.op === 'add' ? 'groupsAddMember' : 'groupsRemoveMember',
        'POST',
        { groupId: request.groupId, userId: request.userId },
        readGroup,
      );
    case 'staff_availability':
      return founderCall(
        ctx,
        'support',
        'staffSetAvailability',
        'POST',
        {
          availability: request.availability,
          ...(request.userId ? { userId: request.userId } : {}),
          ...(request.reason ? { reason: request.reason } : {}),
        },
        readStaffMember,
      );
    case 'properties':
      return founderCall(
        ctx,
        'support',
        'setProperties',
        'POST',
        {
          ticketId: request.ticketId,
          clientRequestId: request.clientRequestId,
          ...(request.priority !== undefined ? { priority: request.priority } : {}),
          ...(request.ticketType !== undefined ? { ticketType: request.ticketType } : {}),
          ...(request.labels !== undefined ? { labels: [...request.labels] } : {}),
          ...(request.reason ? { reason: request.reason } : {}),
        },
        parseWith(supportTicketPropertiesSchema),
      );
    case 'merge':
      return founderCall(
        ctx,
        'support',
        'mergeTickets',
        'POST',
        { sourceId: request.ticketId, survivorId: request.survivorId, reason: request.reason },
        parseWith(supportMergeResultSchema),
      );
    case 'bulk':
      return founderCall(
        ctx,
        'support',
        'bulkUpdate',
        'POST',
        {
          batchKey: request.batchKey,
          ticketIds: [...request.ticketIds],
          change: request.change,
          ...(request.reason ? { reason: request.reason } : {}),
        },
        (raw) => readBulkResults(raw, { batchKey: request.batchKey, ticketIds: request.ticketIds }),
      );
    case 'unclaim':
      return founderCall(
        ctx,
        'support',
        'unclaim',
        'POST',
        { ticketId: request.ticketId, idempotencyKey: request.idempotencyKey },
        parseWith(supportTicketSchema),
      );
    case 'assign':
      return founderCall(
        ctx,
        'support',
        'assign',
        'POST',
        { ticketId: request.ticketId, assigneeId: request.assigneeId, idempotencyKey: request.idempotencyKey },
        parseWith(supportTicketSchema),
      );
    case 'view_save':
      return founderCall(
        ctx,
        'support',
        'viewsSave',
        'POST',
        { name: request.name, expectedRevision: 0, shared: request.shared, filter: request.filter, reason: request.reason },
        parseWith(supportViewSchema),
      );
    case 'kb_publish':
      return founderCall(
        ctx,
        'support',
        'publishKb',
        'POST',
        {
          id: request.id,
          titleKey: request.titleKey,
          bodyKey: request.bodyKey,
          baseRevision: request.baseRevision,
          ...(request.category ? { category: request.category } : {}),
          ...(request.tags ? { tags: request.tags } : {}),
        },
        parseWith(supportKbArticleSchema),
      );
    case 'kb_unpublish':
      return founderCall(
        ctx,
        'support',
        'unpublishKb',
        'POST',
        { id: request.id, baseRevision: request.baseRevision },
        parseWith(supportKbArticleSchema),
      );
    case 'kb_audience':
      return founderCall(
        ctx,
        'support',
        'setKbAudience',
        'POST',
        { id: request.id, baseRevision: request.baseRevision, audience: request.audience },
        parseWith(supportKbArticleSchema),
      );
  }
}
