import 'server-only';
import { createHash } from 'node:crypto';
import {
  supportChartsLookupSchema,
  supportCommentSchema,
  supportTicketEventSchema,
  supportTicketSchema,
  supportViewListSchema,
  supportViewSchema,
} from '@intafaced/contracts';
import {
  SUPPORT_DESK_ACCOUNT_STATE,
  SUPPORT_DESK_ASSIGN,
  SUPPORT_DESK_AVAILABILITY_LOG,
  SUPPORT_DESK_BULK_POLICY,
  SUPPORT_DESK_BULK_UPDATE,
  SUPPORT_DESK_CASE_FILE,
  SUPPORT_DESK_CLAIM,
  SUPPORT_DESK_CLAIM_NEXT,
  SUPPORT_DESK_COMMENT,
  SUPPORT_DESK_ESCALATE,
  SUPPORT_DESK_GROUPS_ADD_MEMBER,
  SUPPORT_DESK_GROUPS_LIST,
  SUPPORT_DESK_GROUPS_LOG,
  SUPPORT_DESK_GROUPS_REMOVE_MEMBER,
  SUPPORT_DESK_GROUPS_SAVE,
  SUPPORT_DESK_INTERNAL_NOTE,
  SUPPORT_DESK_LIST_KB,
  SUPPORT_DESK_MACRO_APPLY,
  SUPPORT_DESK_MACROS,
  SUPPORT_DESK_MERGE,
  SUPPORT_DESK_PREVIEW_MERGE,
  SUPPORT_DESK_PROPERTY_CHANGES,
  SUPPORT_DESK_PUBLISH_KB,
  SUPPORT_DESK_RATING,
  SUPPORT_DESK_RATING_SUMMARY,
  SUPPORT_DESK_ROUTING_OVERVIEW,
  SUPPORT_DESK_ROUTING_SET_MODE,
  SUPPORT_DESK_ROUTING_WAITING,
  SUPPORT_DESK_SCOPE,
  SUPPORT_DESK_SET_KB_AUDIENCE,
  SUPPORT_DESK_SET_PROPERTIES,
  SUPPORT_DESK_SET_STATUS,
  SUPPORT_DESK_SIGNATURE,
  SUPPORT_DESK_SIGNATURE_SET,
  SUPPORT_DESK_STAFF_LIST,
  SUPPORT_DESK_STAFF_POLICY,
  SUPPORT_DESK_STAFF_SET_AVAILABILITY,
  SUPPORT_DESK_STAFF_SET_ROUTING,
  SUPPORT_DESK_TICKET_LIFECYCLE,
  SUPPORT_DESK_TICKET_LINKS,
  SUPPORT_DESK_TICKET_PROPERTIES,
  SUPPORT_DESK_TICKET_ROUTING,
  SUPPORT_DESK_TICKET_SET_SKILL,
  SUPPORT_DESK_UNCLAIM,
  SUPPORT_DESK_UNPUBLISH_KB,
  SUPPORT_DESK_VIEWS_COUNTS,
} from '@intafaced/contracts/support-desk-procedures';
import {
  founderCall,
  founderRecordCall,
  parseWith,
  type FounderCallContext,
  type FounderCallResult,
  partFrom,
  type PartLabels,
} from '@/lib/desk';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY } from './refusal';
import { DESK_COMMENTS_READ, QUEUE_PAGE, readQueueResult, type SupportActionRequest } from './model';
import { EMPTY_QUERY, isQueryEmpty, type QueueQuery } from './queue-query';
import { readBulkResults } from './bulk';
import { groupLogRows, requiredSkillResult, setModeResult } from './routing';
import type {
  SupportKbView,
  SupportLifecycleView,
  SupportMacrosView,
  SupportCustomerView,
  SupportChartsLookupView,
  SupportPropertiesView,
  SupportRatingSummaryView,
  SupportBulkPolicyView,
  SupportQueueView,
  SupportGroupsView,
  SupportGroupLogView,
  SupportRoutingWaitingView,
  SupportStaffView,
  SupportTicketRoutingView,
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

/** The desk's own reading of an answer its record already checked; null reads as unreadable, never as data. */
function mapOk<T, U>(result: FounderCallResult<T>, read: (data: T) => U | null): FounderCallResult<U> {
  if (result.kind !== 'ok') return result;
  const data = read(result.data);
  return data === null ? { kind: 'invalid', requestId: result.requestId } : { ...result, data };
}

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
    founderRecordCall(ctx, SUPPORT_DESK_VIEWS_COUNTS, undefined),
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
    founderCall(ctx, 'support', 'listComments', 'GET', { ticketId, limit: DESK_COMMENTS_READ }, arrayOf(supportCommentSchema)),
    founderCall(ctx, 'support', 'events', 'GET', { ticketId, limit: 100 }, arrayOf(supportTicketEventSchema)),
    founderRecordCall(ctx, SUPPORT_DESK_PROPERTY_CHANGES, { ticketId, limit: 100 }),
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

export function claimTicket(
  ctx: FounderCallContext,
  ticketId: string,
): Promise<FounderCallResult<ReturnType<typeof supportTicketSchema.parse>>> {
  return founderRecordCall(ctx, SUPPORT_DESK_CLAIM, { ticketId });
}

/**
 * The operator-only reads on one ticket: the case file an escalation was made against, and the customer's rating.
 * Both are `support:ops`. Each is its own part: a refusal on one is shown as that part's refusal, never as "none".
 */
export async function loadTicketExtras(ctx: FounderCallContext, ticketId: string, now: Date = new Date()): Promise<TicketExtrasView> {
  const [caseFile, rating] = await Promise.all([
    founderRecordCall(ctx, SUPPORT_DESK_CASE_FILE, { ticketId }),
    founderRecordCall(ctx, SUPPORT_DESK_RATING, { ticketId }),
  ]);
  return {
    asOf: now.toISOString(),
    caseFile: partFrom(caseFile, (c) => c, LABELS),
    rating: partFrom(rating, (r) => r, LABELS),
  };
}

/** Priority, type and labels on one ticket. Its own read, so a refusal here never hides the ticket. */
export async function loadTicketProperties(
  ctx: FounderCallContext,
  ticketId: string,
  now: Date = new Date(),
): Promise<SupportPropertiesView> {
  const result = await founderRecordCall(ctx, SUPPORT_DESK_TICKET_PROPERTIES, { ticketId });
  return { asOf: now.toISOString(), properties: partFrom(result, (p) => p, LABELS) };
}

/**
 * The customer card's account state, read through svc-support (which takes the account from the request, never from
 * the caller, and writes the read to the request's history). A refusal or an unreachable service is the part's
 * failure, shown as unread: never a guessed state.
 */
export async function loadCustomerCard(ctx: FounderCallContext, ticketId: string, now: Date = new Date()): Promise<SupportCustomerView> {
  const [account, links] = await Promise.all([
    founderRecordCall(ctx, SUPPORT_DESK_ACCOUNT_STATE, { ticketId }),
    founderRecordCall(ctx, SUPPORT_DESK_TICKET_LINKS, { ticketId }),
  ]);
  return {
    asOf: now.toISOString(),
    account: partFrom(account, (a) => a, LABELS),
    // The order ids among the request's links.
    orders: partFrom(links, (l) => l.filter((link) => link.kind === 'order').map((link) => link.recordId), LABELS),
  };
}

/**
 * A customer's price alerts with their history and saved desk layouts, for this ticket (J-charts-desk-19 #1). svc-support
 * takes the customer from the ticket and writes one audit row before it reads; a lookup whose row did not land is refused,
 * and the part says so.
 */
export async function loadChartsLookup(
  ctx: FounderCallContext,
  ticketId: string,
  now: Date = new Date(),
): Promise<SupportChartsLookupView> {
  const result = await founderCall(ctx, 'support', 'ticketChartsLookup', 'GET', { ticketId }, parseWith(supportChartsLookupSchema));
  return {
    asOf: now.toISOString(),
    lookup: partFrom(result, (l) => l, {
      ...LABELS,
      refusedMessage: (code) =>
        code === 'support.charts_lookup_unaudited'
          ? 'svc-support could not record this lookup in the request history, so it read nothing. Try again.'
          : null,
    }),
  };
}

/** Who a ticket waits on and the request it follows. Its own read, so a refusal here never hides the ticket. */
export async function loadTicketLifecycle(
  ctx: FounderCallContext,
  ticketId: string,
  now: Date = new Date(),
): Promise<SupportLifecycleView> {
  const result = await founderRecordCall(ctx, SUPPORT_DESK_TICKET_LIFECYCLE, { ticketId });
  return { asOf: now.toISOString(), lifecycle: partFrom(result, (l) => l, LABELS) };
}

/** Ratings for the requests solved in the stated window. Its own read, so a refusal here never hides the queue. */
export async function loadRatingSummary(
  ctx: FounderCallContext,
  window: { readonly from: string; readonly to: string },
  now: Date = new Date(),
): Promise<SupportRatingSummaryView> {
  const result = await founderRecordCall(ctx, SUPPORT_DESK_RATING_SUMMARY, { from: window.from, to: window.to });
  return { asOf: now.toISOString(), summary: partFrom(result, (r) => r, LABELS) };
}

/**
 * Who is on the support staff (with their groups), whether automatic offline is set, each person's capacity and skills, and
 * the availability log. Four reads, each its own part.
 */
export async function loadStaff(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportStaffView> {
  const [roster, policy, routing, log] = await Promise.all([
    founderRecordCall(ctx, SUPPORT_DESK_STAFF_LIST, undefined),
    founderRecordCall(ctx, SUPPORT_DESK_STAFF_POLICY, undefined),
    founderRecordCall(ctx, SUPPORT_DESK_ROUTING_OVERVIEW, undefined),
    founderRecordCall(ctx, SUPPORT_DESK_AVAILABILITY_LOG, {}),
  ]);
  return {
    asOf: now.toISOString(),
    meId: ctx.session.userId,
    roster: partFrom(roster, (r) => r, LABELS),
    policy: partFrom(policy, (p) => p, LABELS),
    routing: partFrom(routing, (r) => r, LABELS),
    log: partFrom(log, (l) => l, LABELS),
  };
}

/** One group's log, oldest first. */
export async function loadGroupLog(ctx: FounderCallContext, groupId: string, now: Date = new Date()): Promise<SupportGroupLogView> {
  const result = await mapOk(await founderRecordCall(ctx, SUPPORT_DESK_GROUPS_LOG, { groupId }), groupLogRows);
  return { asOf: now.toISOString(), groupId, log: partFrom(result, (l) => l, LABELS) };
}

/** Requests in a routed group that no agent could take, as svc-support lists them for this person. */
export async function loadRoutingWaiting(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportRoutingWaitingView> {
  const result = await founderRecordCall(ctx, SUPPORT_DESK_ROUTING_WAITING, undefined);
  return { asOf: now.toISOString(), waiting: partFrom(result, (w) => w, LABELS) };
}

/** One request's routing and the roster (to say whether this person is a lead). Two reads, each its own part. */
export async function loadTicketRouting(
  ctx: FounderCallContext,
  ticketId: string,
  now: Date = new Date(),
): Promise<SupportTicketRoutingView> {
  const [routing, roster] = await Promise.all([
    founderRecordCall(ctx, SUPPORT_DESK_TICKET_ROUTING, { ticketId }),
    founderRecordCall(ctx, SUPPORT_DESK_STAFF_LIST, undefined),
  ]);
  return {
    asOf: now.toISOString(),
    meId: ctx.session.userId,
    routing: partFrom(routing, (r) => r, LABELS),
    roster: partFrom(roster, (r) => r, LABELS),
  };
}

/** The desk's macros and the signed-in agent's own signature (SP-desk-02). Two reads, each its own part. */
export async function loadMacros(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportMacrosView> {
  const [macros, signature] = await Promise.all([
    founderRecordCall(ctx, SUPPORT_DESK_MACROS, undefined),
    founderRecordCall(ctx, SUPPORT_DESK_SIGNATURE, undefined),
  ]);
  return {
    asOf: now.toISOString(),
    macros: partFrom(macros, (m) => m.macros, LABELS),
    signature: partFrom(signature, (s) => s, LABELS),
  };
}

/** One macro filled from one request, for the agent's draft. svc-support writes nothing; the agent sends the reply. */
export function applyMacro(ctx: FounderCallContext, ticketId: string, macroId: string) {
  return founderRecordCall(ctx, SUPPORT_DESK_MACRO_APPLY, { ticketId, macroId });
}

/** Desk groups, this person's own scope, the roster and each group's routing. Four reads, each its own part. */
export async function loadGroups(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportGroupsView> {
  const [groups, scope, roster, routing] = await Promise.all([
    founderRecordCall(ctx, SUPPORT_DESK_GROUPS_LIST, undefined),
    founderRecordCall(ctx, SUPPORT_DESK_SCOPE, undefined),
    founderRecordCall(ctx, SUPPORT_DESK_STAFF_LIST, undefined),
    founderRecordCall(ctx, SUPPORT_DESK_ROUTING_OVERVIEW, undefined),
  ]);
  return {
    asOf: now.toISOString(),
    meId: ctx.session.userId,
    groups: partFrom(groups, (g) => g, LABELS),
    scope: partFrom(scope, (x) => x, LABELS),
    roster: partFrom(roster, (r) => r, LABELS),
    routing: partFrom(routing, (r) => r, LABELS),
  };
}

/** Published help articles, with the revision a publish or unpublish must quote. svc-support lists no unpublished ones. */
export async function loadKb(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportKbView> {
  const result = await founderRecordCall(ctx, SUPPORT_DESK_LIST_KB, { limit: 100 });
  return { asOf: now.toISOString(), articles: partFrom(result, (a) => a, LABELS) };
}

/** What a merge of one request into another would move, for the confirmation. Reads only; a refusal is returned as it is. */
export async function previewMerge(ctx: FounderCallContext, sourceId: string, survivorId: string) {
  return founderRecordCall(ctx, SUPPORT_DESK_PREVIEW_MERGE, { sourceId, survivorId });
}

/** The owner's bulk batch size, or `cap: null` while it is not set. A failed read is the part's failure, never a number. */
export async function loadBulkPolicy(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportBulkPolicyView> {
  const result = await founderRecordCall(ctx, SUPPORT_DESK_BULK_POLICY, undefined);
  return { asOf: now.toISOString(), policy: partFrom(result, (p) => ({ cap: p.cap }), LABELS) };
}

/**
 * A reply's business key: the request, the trail row the agent read and the text. Sent again after an unknown outcome it
 * is the same key, so svc-support answers the stored reply and writes no second one; a different reply is a new key.
 */
export function replyKey(ticketId: string, agentId: string, expectedSequence: number, sent: number, body: string): string {
  return deskKey('admin-reply', ticketId, agentId, expectedSequence, sent, body);
}

function deskKey(kind: string, ticketId: string, agentId: string, expectedSequence: number, sent: number, body: string): string {
  const text = createHash('sha256').update(body).digest('hex').slice(0, 32);
  return `${kind}:${ticketId}:${agentId}:${expectedSequence}:${sent}:${text}`;
}

/**
 * An internal note's business key, built as a reply's is and kept apart from it (svc-support also keeps a note's keys
 * apart from a reply's). Sent again after an unknown outcome it is the same key, so svc-support answers the stored note.
 */
export function noteKey(ticketId: string, agentId: string, expectedSequence: number, sent: number, body: string): string {
  return deskKey('admin-note', ticketId, agentId, expectedSequence, sent, body);
}

/**
 * One desk write, as the signed-in founder. svc-support takes the operator id from the verified session, so a reply,
 * a status change or an escalation is recorded against the person at the keyboard.
 */
export async function runSupportAction(ctx: FounderCallContext, request: SupportActionRequest): Promise<FounderCallResult<unknown>> {
  switch (request.action) {
    case 'reply':
      return founderRecordCall(ctx, SUPPORT_DESK_COMMENT, {
        ticketId: request.ticketId,
        body: request.body,
        ...(request.expectedSequence === undefined
          ? {}
          : {
              expectedSequence: request.expectedSequence,
              clientRequestId: replyKey(request.ticketId, ctx.session.userId, request.expectedSequence, request.sent ?? 0, request.body),
            }),
      });
    case 'note':
      return founderRecordCall(ctx, SUPPORT_DESK_INTERNAL_NOTE, {
        ticketId: request.ticketId,
        body: request.body,
        clientRequestId: noteKey(request.ticketId, ctx.session.userId, request.expectedSequence, request.sent, request.body),
      });
    case 'claim_next':
      return founderRecordCall(ctx, SUPPORT_DESK_CLAIM_NEXT, undefined);
    // The business key is the request, the person and the trail row they read: the same click sent twice is one change,
    // and the next unclaim or reassign (after the trail has moved on) is a new one.
    case 'unclaim':
      return founderRecordCall(ctx, SUPPORT_DESK_UNCLAIM, {
        ticketId: request.ticketId,
        idempotencyKey: `admin-unclaim:${request.ticketId}:${ctx.session.userId}:${request.expectedSequence}`,
      });
    case 'assign':
      return founderRecordCall(ctx, SUPPORT_DESK_ASSIGN, {
        ticketId: request.ticketId,
        assigneeId: request.assigneeId,
        idempotencyKey: `admin-assign:${request.ticketId}:${ctx.session.userId}:${request.assigneeId}:${request.expectedSequence}`,
      });
    case 'status':
      return founderRecordCall(ctx, SUPPORT_DESK_SET_STATUS, {
        ticketId: request.ticketId,
        status: request.status,
        ...(request.note ? { note: request.note } : {}),
        ...(request.expectedSequence === undefined ? {} : { expectedSequence: request.expectedSequence }),
      });
    case 'escalate':
      return founderRecordCall(ctx, SUPPORT_DESK_ESCALATE, {
        ticketId: request.ticketId,
        reason: request.reason,
        summary: request.summary,
        ...(request.citedArticleIds ? { citedArticleIds: [...request.citedArticleIds] } : {}),
      });
    case 'group_save':
      return founderRecordCall(ctx, SUPPORT_DESK_GROUPS_SAVE, {
        name: request.name,
        idempotencyKey: request.idempotencyKey,
        ...(request.groupId ? { groupId: request.groupId } : {}),
      });
    case 'group_member':
      return founderRecordCall(ctx, request.op === 'add' ? SUPPORT_DESK_GROUPS_ADD_MEMBER : SUPPORT_DESK_GROUPS_REMOVE_MEMBER, {
        groupId: request.groupId,
        userId: request.userId,
      });
    case 'staff_availability':
      return founderRecordCall(ctx, SUPPORT_DESK_STAFF_SET_AVAILABILITY, {
        availability: request.availability,
        ...(request.userId ? { userId: request.userId } : {}),
        ...(request.reason ? { reason: request.reason } : {}),
      });
    case 'routing_mode':
      return mapOk(
        await founderRecordCall(ctx, SUPPORT_DESK_ROUTING_SET_MODE, { groupId: request.groupId, mode: request.mode }),
        setModeResult,
      );
    case 'staff_routing':
      return founderRecordCall(ctx, SUPPORT_DESK_STAFF_SET_ROUTING, {
        userId: request.userId,
        capacity: request.capacity,
        skills: [...request.skills],
      });
    case 'ticket_skill':
      return mapOk(
        await founderRecordCall(ctx, SUPPORT_DESK_TICKET_SET_SKILL, { ticketId: request.ticketId, skill: request.skill }),
        requiredSkillResult,
      );
    case 'properties':
      return founderRecordCall(ctx, SUPPORT_DESK_SET_PROPERTIES, {
        ticketId: request.ticketId,
        clientRequestId: request.clientRequestId,
        ...(request.priority !== undefined ? { priority: request.priority } : {}),
        ...(request.ticketType !== undefined ? { ticketType: request.ticketType } : {}),
        ...(request.labels !== undefined ? { labels: [...request.labels] } : {}),
        ...(request.reason ? { reason: request.reason } : {}),
      });
    case 'merge':
      return founderRecordCall(ctx, SUPPORT_DESK_MERGE, {
        sourceId: request.ticketId,
        survivorId: request.survivorId,
        reason: request.reason,
      });
    case 'bulk':
      // The answer must carry the key that was sent and name exactly the requests that were sent.
      return mapOk(
        await founderRecordCall(ctx, SUPPORT_DESK_BULK_UPDATE, {
          batchKey: request.batchKey,
          ticketIds: [...request.ticketIds],
          change: request.change,
          ...(request.reason ? { reason: request.reason } : {}),
        }),
        (reply) => readBulkResults(reply, { batchKey: request.batchKey, ticketIds: request.ticketIds }),
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
      return founderRecordCall(ctx, SUPPORT_DESK_PUBLISH_KB, {
        id: request.id,
        titleKey: request.titleKey,
        bodyKey: request.bodyKey,
        baseRevision: request.baseRevision,
        ...(request.category ? { category: request.category } : {}),
        ...(request.tags ? { tags: [...request.tags] } : {}),
      });
    case 'signature_set':
      return founderRecordCall(ctx, SUPPORT_DESK_SIGNATURE_SET, {
        signature: request.signature,
        expectedRevision: request.expectedRevision,
      });
    case 'kb_unpublish':
      return founderRecordCall(ctx, SUPPORT_DESK_UNPUBLISH_KB, { id: request.id, baseRevision: request.baseRevision });
    case 'kb_audience':
      return founderRecordCall(ctx, SUPPORT_DESK_SET_KB_AUDIENCE, {
        id: request.id,
        baseRevision: request.baseRevision,
        audience: request.audience,
      });
  }
}
