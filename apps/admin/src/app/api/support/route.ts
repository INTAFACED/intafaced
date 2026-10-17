import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { isTicketId } from '@/lib/support/model';
import { claimTicket, loadQueue, loadTicket } from '@/lib/support/server';

/**
 * Support desk BFF: the operator queue, one ticket, and claiming a ticket.
 *
 * Runs as the signed-in founder: svc-support takes the operator id from the verified session, so a claim is recorded
 * against the founder who made it and cannot be made on anyone else's behalf. Every procedure is `support:ops`; if
 * founder sign-in does not carry it, svc-support answers 403 and the desk says that (admin-BACKEND-NEEDS.md).
 *
 * There is no unclaim or reassign: svc-support has none. That is why a claim needs a second click in the page.
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
  return Response.json(await loadQueue(session), { headers: NO_STORE });
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
  if (raw.action !== 'claim' || !isTicketId(raw.ticketId)) {
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
            title: 'Your session does not hold the support-staff permission',
            body: 'svc-support only lets staff with support:ops claim tickets, and founder sign-in does not carry it yet.',
            next: 'Nothing was changed. See the back-end needs note.',
          }
        : { ...base, body: result.refusal.message !== '' ? result.refusal.message : base.body };
    return Response.json({ ok: false, refusal: view }, { status: 409, headers: NO_STORE });
  }
  if (result.kind === 'unavailable') {
    return Response.json({ ok: false, refusal: explainRefusal(null, 503, result.uncertain) }, { status: 502, headers: NO_STORE });
  }
  return Response.json({ ok: false, refusal: explainRefusal(null, 502, true) }, { status: 502, headers: NO_STORE });
}
