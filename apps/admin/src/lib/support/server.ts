import 'server-only';
import {
  supportCaseFileSchema,
  supportCommentSchema,
  supportKbArticleSchema,
  supportTicketEventSchema,
  supportTicketPropertiesSchema,
  supportTicketSchema,
} from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY } from './refusal';
import { QUEUE_PAGE, readQueueResult, readRatingResult, type SupportActionRequest } from './model';
import { readStaffMember, readStaffPolicy, readStaffRoster } from './staff';
import type {
  SupportKbView,
  SupportPropertiesView,
  SupportQueueView,
  SupportStaffView,
  SupportTicketView,
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

export async function loadQueue(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportQueueView> {
  const result = await founderCall(ctx, 'support', 'listQueue', 'GET', { limit: QUEUE_PAGE }, (raw) => readQueueResult(raw, QUEUE_PAGE));
  return { asOf: now.toISOString(), queue: partFrom(result, (d) => d, LABELS) };
}

export async function loadTicket(ctx: FounderCallContext, ticketId: string, now: Date = new Date()): Promise<SupportTicketView> {
  const [ticket, comments, events] = await Promise.all([
    founderCall(ctx, 'support', 'get', 'GET', { ticketId }, parseWith(supportTicketSchema)),
    founderCall(ctx, 'support', 'listComments', 'GET', { ticketId, limit: 100 }, arrayOf(supportCommentSchema)),
    founderCall(ctx, 'support', 'events', 'GET', { ticketId, limit: 100 }, arrayOf(supportTicketEventSchema)),
  ]);
  const detail = partFrom(
    ticket,
    (t) => ({
      ticket: t,
      comments: partFrom(comments, (c) => c, LABELS),
      events: partFrom(events, (e) => e, LABELS),
    }),
    LABELS,
  );
  return { asOf: now.toISOString(), detail };
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

/** Published help articles, with the revision a publish or unpublish must quote. svc-support lists no unpublished ones. */
export async function loadKb(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportKbView> {
  const result = await founderCall(ctx, 'support', 'listKb', 'GET', { limit: 100 }, arrayOf(supportKbArticleSchema));
  return { asOf: now.toISOString(), articles: partFrom(result, (a) => a, LABELS) };
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
        { ticketId: request.ticketId, body: request.body },
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
  }
}
