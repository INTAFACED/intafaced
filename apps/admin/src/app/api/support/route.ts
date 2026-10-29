import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { bulkSummary, type BulkRow } from '@/lib/support/bulk';
import { isTicketId, readActionRequest, type SupportActionRequest } from '@/lib/support/model';
import { readQueueQuery } from '@/lib/support/queue-query';
import { SUPPORT_OPS_FORBIDDEN, SUPPORT_OPS_FORBIDDEN_BODY, explainSupportFailure } from '@/lib/support/refusal';
import {
  claimNextTicket,
  claimTicket,
  loadCustomerCard,
  loadBulkPolicy,
  loadKb,
  loadQueue,
  loadTicket,
  loadTicketExtras,
  loadGroups,
  loadStaff,
  loadRatingSummary,
  loadTicketLifecycle,
  loadTicketProperties,
  loadViews,
  previewMerge,
  runSupportAction,
} from '@/lib/support/server';
import type { FounderCallFailure } from '@/lib/desk/founder-call';

/**
 * Support desk BFF: the operator queue, one ticket (with its case file and rating), the help articles, and the desk's
 * writes: claim (one ticket, or the next in the queue), unclaim, reassign, reply, set status, escalate, publish and
 * unpublish an article.
 *
 * Runs as the signed-in founder: svc-support takes the operator id from the verified session, so a claim is recorded
 * against the founder who made it and cannot be made on anyone else's behalf. Every procedure is `support:ops`; if
 * founder sign-in does not carry it, svc-support answers 403 and the desk says that (admin-BACKEND-NEEDS.md).
 *
 * A claim of an opened ticket takes a second click in the page; "claim the next request", unclaim and reassign take one,
 * since each can be undone from here (svc-support lets only the assignee unclaim and only a lead reassign, and says so
 * when it refuses). Every other write needs a second click: a reply cannot be unsent, a closed ticket stays closed, an escalation's case file is immutable, and
 * a published article changes what customers read. No write here moves money, and none needs a second approver.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('support');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  const url = new URL(request.url);
  if (url.searchParams.get('view') === 'ticket') {
    const id = url.searchParams.get('id');
    if (!isTicketId(id)) return Response.json({ code: 'admin.support_ticket_id' }, { status: 400, headers: NO_STORE });
    return Response.json(await loadTicket(session, id), { headers: NO_STORE });
  }
  if (url.searchParams.get('view') === 'extras') {
    const id = url.searchParams.get('id');
    if (!isTicketId(id)) return Response.json({ code: 'admin.support_ticket_id' }, { status: 400, headers: NO_STORE });
    return Response.json(await loadTicketExtras(session, id), { headers: NO_STORE });
  }
  if (url.searchParams.get('view') === 'customer') {
    const id = url.searchParams.get('id');
    if (!isTicketId(id)) return Response.json({ code: 'admin.support_ticket_id' }, { status: 400, headers: NO_STORE });
    return Response.json(await loadCustomerCard(session, id), { headers: NO_STORE });
  }
  if (url.searchParams.get('view') === 'merge') {
    const id = url.searchParams.get('id');
    const survivor = url.searchParams.get('survivor');
    if (!isTicketId(id) || !isTicketId(survivor))
      return Response.json({ code: 'admin.support_ticket_id' }, { status: 400, headers: NO_STORE });
    const result = await previewMerge(session, id, survivor);
    if (result.kind !== 'ok') {
      return Response.json({ ok: false, refusal: explainSupportFailure(result) }, { status: statusOf(result), headers: NO_STORE });
    }
    return Response.json({ asOf: new Date().toISOString(), preview: result.data }, { headers: NO_STORE });
  }
  if (url.searchParams.get('view') === 'bulk') return Response.json(await loadBulkPolicy(session), { headers: NO_STORE });
  if (url.searchParams.get('view') === 'groups') return Response.json(await loadGroups(session), { headers: NO_STORE });
  if (url.searchParams.get('view') === 'staff') return Response.json(await loadStaff(session), { headers: NO_STORE });
  if (url.searchParams.get('view') === 'properties') {
    const id = url.searchParams.get('id');
    if (!isTicketId(id)) return Response.json({ code: 'admin.support_ticket_id' }, { status: 400, headers: NO_STORE });
    return Response.json(await loadTicketProperties(session, id), { headers: NO_STORE });
  }
  if (url.searchParams.get('view') === 'lifecycle') {
    const id = url.searchParams.get('id');
    if (!isTicketId(id)) return Response.json({ code: 'admin.support_ticket_id' }, { status: 400, headers: NO_STORE });
    return Response.json(await loadTicketLifecycle(session, id), { headers: NO_STORE });
  }
  if (url.searchParams.get('view') === 'ratings') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const start = from === null ? NaN : Date.parse(from);
    const end = to === null ? NaN : Date.parse(to);
    if (!from || !to || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      return Response.json({ code: 'admin.support_rating_window' }, { status: 400, headers: NO_STORE });
    }
    return Response.json(await loadRatingSummary(session, { from: new Date(start).toISOString(), to: new Date(end).toISOString() }), {
      headers: NO_STORE,
    });
  }
  if (url.searchParams.get('view') === 'kb') return Response.json(await loadKb(session), { headers: NO_STORE });
  if (url.searchParams.get('view') === 'views') return Response.json(await loadViews(session), { headers: NO_STORE });
  // The queue, narrowed by `filter`, `q` or `savedView` (a saved view's id; `view` names the part of the desk asked for).
  const query = readQueueQuery({
    get: (name) => url.searchParams.get(name === 'view' ? 'savedView' : name),
  });
  return Response.json(await loadQueue(session, query), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('support');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;

  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  if (raw.action === 'claim_next') {
    if (Object.keys(raw).length !== 1) return Response.json(INVALID, { status: 400, headers: NO_STORE });
    const result = await claimNextTicket(session);
    console.warn(
      JSON.stringify({
        audit: 'admin.support_claim_next',
        at: new Date().toISOString(),
        founder: session.session.userId,
        ticketId: result.kind === 'ok' ? result.data.id : null,
        outcome: result.kind,
      }),
    );
    if (result.kind === 'empty') {
      return Response.json(
        {
          ok: false,
          refusal: {
            title: 'Nothing to claim',
            body: 'svc-support says no open or waiting request is free: every one is already held, or the queue is empty.',
            next: 'Refresh the queue later.',
            code: 'admin.support_queue_empty',
            changed: 'no',
          },
        },
        { status: 409, headers: NO_STORE },
      );
    }
    return claimResponse(result);
  }
  if (raw.action !== 'claim') return writeAction(session, raw);
  if (!isTicketId(raw.ticketId)) {
    return Response.json(
      {
        ok: false,
        refusal: {
          title: 'That request was not accepted',
          body: 'A claim names one ticket by its id. Nothing was sent.',
          next: 'Open the ticket from the queue and try again.',
          code: 'admin.request_invalid',
          changed: 'no',
        },
      },
      { status: 400, headers: NO_STORE },
    );
  }

  const result = await claimTicket(session, raw.ticketId);
  console.warn(
    JSON.stringify({
      audit: 'admin.support_claim',
      at: new Date().toISOString(),
      founder: session.session.userId,
      ticketId: raw.ticketId,
      outcome: result.kind,
    }),
  );
  return claimResponse(result);
}

/** A claim's answer for the page: the ticket's new owner, or svc-support's refusal in the console's words. */
function claimResponse(result: Awaited<ReturnType<typeof claimTicket>>): Response {
  if (result.kind === 'ok') {
    const t = result.data;
    return Response.json({ ok: true, ticketId: t.id, assigneeId: t.assigneeId, status: t.status }, { headers: NO_STORE });
  }
  if (result.kind === 'forbidden' || result.kind === 'refused') {
    const base = explainRefusal(result.refusal.code, result.refusal.status, false);
    const view =
      result.kind === 'forbidden'
        ? {
            ...base,
            title: SUPPORT_OPS_FORBIDDEN,
            body: SUPPORT_OPS_FORBIDDEN_BODY,
            next: 'Nothing was changed. This control works once the permission is granted.',
          }
        : { ...base, body: result.refusal.message !== '' ? result.refusal.message : base.body };
    return Response.json({ ok: false, refusal: view }, { status: 409, headers: NO_STORE });
  }
  if (result.kind === 'unavailable') {
    return Response.json({ ok: false, refusal: explainRefusal(null, 503, result.uncertain) }, { status: 502, headers: NO_STORE });
  }
  return Response.json({ ok: false, refusal: explainRefusal(null, 502, true) }, { status: 502, headers: NO_STORE });
}

type Session = Exclude<Awaited<ReturnType<typeof adminBffSession>>, Response>;

const INVALID = {
  ok: false,
  refusal: {
    title: 'That request was not accepted',
    body: 'It did not name a known action with valid fields, so nothing was sent.',
    next: 'Check the fields and try again.',
    code: 'admin.request_invalid',
    changed: 'no',
  },
} as const;

const targetOf = (request: SupportActionRequest) =>
  request.action === 'staff_availability'
    ? (request.userId ?? 'self')
    : request.action === 'group_save'
      ? (request.groupId ?? 'new')
      : request.action === 'group_member'
        ? request.groupId
        : request.action === 'bulk'
          ? request.batchKey
          : request.action === 'view_save'
            ? `view:${request.name}`
            : request.action === 'merge'
              ? `${request.ticketId}->${request.survivorId}`
              : 'ticketId' in request
                ? request.ticketId
                : request.id;

function statusOf(failure: FounderCallFailure<unknown>): number {
  if (failure.kind === 'forbidden') return failure.refusal.status === 401 ? 401 : 403;
  if (failure.kind === 'refused') return 409;
  return 502;
}

async function writeAction(session: Session, raw: Record<string, unknown>) {
  const request = readActionRequest(raw);
  if (!request) return Response.json(INVALID, { status: 400, headers: NO_STORE });
  const result = await runSupportAction(session, request);
  // The audit line names who did what to which ticket or article. It never carries the words the founder wrote.
  console.warn(
    JSON.stringify({
      audit: `admin.support_${request.action}`,
      at: new Date().toISOString(),
      founder: session.session.userId,
      target: targetOf(request),
      outcome: result.kind,
    }),
  );
  if (result.kind !== 'ok') {
    return Response.json({ ok: false, refusal: explainSupportFailure(result) }, { status: statusOf(result), headers: NO_STORE });
  }
  return Response.json(
    {
      ok: true,
      action: request.action,
      summary: summaryOf(request, result.data),
      ...(request.action === 'bulk' ? { results: result.data } : {}),
    },
    { headers: NO_STORE },
  );
}

function audienceWords(audience: unknown): string {
  if (audience === 'signed_in') return 'signed-in customers only';
  if (audience === 'staff') return 'staff only';
  return 'everyone';
}

/** What svc-support says happened, in a sentence, taken from its own answer and not from what was sent. */
function summaryOf(request: SupportActionRequest, data: unknown): string {
  const d = data as Record<string, unknown>;
  switch (request.action) {
    case 'reply':
      return 'svc-support recorded your reply on the ticket.';
    case 'unclaim':
      return d.assigneeId === null
        ? 'svc-support says nobody holds the ticket now; it is back in the queue.'
        : `svc-support says the ticket is held by ${String(d.assigneeId)}.`;
    case 'assign':
      return `svc-support says the ticket is now held by ${String(d.assigneeId)}.`;
    case 'merge':
      return `svc-support merged the request: ${String(d.commentsMoved)} messages and ${String(d.attachmentsMoved)} files now sit under the surviving request, and the duplicate is closed.`;
    case 'status':
      return `svc-support says the ticket is now ${String(d.status)}.`;
    case 'group_save':
      return `svc-support saved the group as "${String(d.name)}".`;
    case 'group_member':
      return `svc-support says the group now has ${Array.isArray(d.memberIds) ? d.memberIds.length : 'an unknown number of'} members.`;
    case 'staff_availability':
      return `svc-support says the person is now ${String(d.availability)}.`;
    case 'bulk':
      return Array.isArray(data) ? bulkSummary(data as BulkRow[]) : 'svc-support answered the bulk change.';
    case 'properties':
      return 'svc-support recorded the new priority, type and labels on the ticket.';
    case 'view_save':
      return `svc-support saved the view "${String(d.name)}"${d.shared === true ? ', shared with the team' : ', for you only'}.`;
    case 'escalate':
      return `svc-support filed the case file with ${Array.isArray(d.citations) ? d.citations.length : 'its'} citations.`;
    case 'kb_publish':
      return `svc-support says ${String(d.id)} is published at revision ${String(d.revision)}.`;
    case 'kb_audience':
      return `svc-support says ${String(d.id)} is now readable by ${audienceWords(d.audience)}. Its revision is now ${String(d.revision)}.`;
    case 'kb_unpublish':
      return `svc-support says ${String(d.id)} is hidden from customers. Its revision is now ${String(d.revision)}; quote it to publish it again.`;
  }
}
