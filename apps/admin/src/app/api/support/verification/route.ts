import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { explainVerificationFailure, isUuid, readVerificationRequest, RECORD_KIND_WORDS } from '@/lib/support/verification';
import { loadVerification, runVerification } from '@/lib/support/verification-server';

/**
 * Balance disclosure gate (RC-support-public-01, J-support-public-20 #2). GET reads the checks on one request; POST records a
 * check (a record its owner says is the customer's) or asks for the balance or withdrawal destination behind the gate.
 *
 * Runs as the signed-in founder; svc-support takes the actor from the verified session and the customer off the ticket. A
 * read behind the gate has no success answer today: it refuses for want of checks, or for want of a read.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const INVALID = {
  ok: false,
  refusal: {
    title: 'That request was not accepted',
    body: 'A check names a ticket, a record kind and the record id; a read names a ticket and what to read. Nothing was sent.',
    next: 'Fix the fields and try again.',
    code: 'admin.request_invalid',
    changed: 'no',
  },
} as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('support');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const id = new URL(request.url).searchParams.get('id');
  if (!isUuid(id)) return Response.json({ code: 'admin.support_ticket_id' }, { status: 400, headers: NO_STORE });
  return Response.json(await loadVerification(session, id.trim().toLowerCase()), { headers: NO_STORE });
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
  const ask = readVerificationRequest(raw);
  if (!ask) return Response.json(INVALID, { status: 400, headers: NO_STORE });

  const result = await runVerification(session, ask);
  // The audit line names who asked for what on which ticket, and never a record id.
  console.warn(
    JSON.stringify({
      audit: ask.action === 'check' ? 'admin.support_verification_check' : `admin.support_disclosure_${ask.what}`,
      at: new Date().toISOString(),
      founder: session.session.userId,
      ticketId: ask.ticketId,
      outcome: result.kind,
    }),
  );
  if (result.kind === 'ok' && ask.action === 'check') {
    return Response.json(
      {
        ok: true,
        summary: `svc-support recorded the ${RECORD_KIND_WORDS[ask.recordKind].toLowerCase()} as a check the customer can confirm.`,
      },
      { headers: NO_STORE },
    );
  }
  if (result.kind === 'ok' || result.kind === 'invalid') {
    return Response.json(
      {
        ok: false,
        refusal: {
          title: 'The answer was not understood',
          body: 'svc-support answered in a shape this console does not show. Nothing is shown rather than a guess.',
          next: 'Read the request again before asking twice.',
          code: 'admin.ops_invalid_response',
          changed: ask.action === 'check' ? 'unknown' : 'no',
        },
      },
      { status: 502, headers: NO_STORE },
    );
  }
  const status = result.kind === 'forbidden' ? (result.refusal.status === 401 ? 401 : 403) : result.kind === 'refused' ? 409 : 502;
  return Response.json({ ok: false, refusal: explainVerificationFailure(result) }, { status, headers: NO_STORE });
}
