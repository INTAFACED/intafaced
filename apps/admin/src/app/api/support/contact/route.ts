import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { readContactSetRequest } from '@/lib/support/contact';
import { explainContactFailure } from '@/lib/support/contact-refusal';
import { loadContact, setContact } from '@/lib/support/contact-server';

/**
 * Support contact channels (SP-help-centre-01). GET reads the owner-set email, phone and chat hours; POST sets one or more.
 *
 * Runs as the signed-in founder: svc-support takes the actor from the verified session and lets only a staff lead write.
 * The page names the revision it read, so a second operator's change is never overwritten unseen. Done is reported only when
 * the record svc-support returns holds a higher revision than the one sent; any other answer is "outcome unknown".
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('support');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadContact(session), { headers: NO_STORE });
}

const INVALID = {
  ok: false,
  refusal: {
    title: 'That request was not accepted',
    body: 'A change names the fields to set, the revision you read and a reason. Nothing was sent.',
    next: 'Fix the fields and try again.',
    code: 'admin.request_invalid',
    changed: 'no',
  },
} as const;

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
  const change = readContactSetRequest(raw);
  if (!change) return Response.json(INVALID, { status: 400, headers: NO_STORE });

  const result = await setContact(session, change);
  // The audit line names who changed which fields. It never carries the values or the reason.
  console.warn(
    JSON.stringify({
      audit: 'admin.support_contact_set',
      at: new Date().toISOString(),
      founder: session.session.userId,
      fields: Object.keys(change.changes),
      outcome: result.kind,
    }),
  );
  if (result.kind === 'ok') {
    if (result.data.revision <= change.expectedRevision) {
      return Response.json(
        {
          ok: false,
          refusal: {
            title: 'The outcome is not known',
            body: 'svc-support answered, but its record does not show the change.',
            next: 'Reload the details before changing them again.',
            code: 'admin.ops_invalid_response',
            changed: 'unknown',
          },
        },
        { status: 502, headers: NO_STORE },
      );
    }
    return Response.json({ ok: true, contact: result.data }, { headers: NO_STORE });
  }
  const status = result.kind === 'forbidden' ? (result.refusal.status === 401 ? 401 : 403) : result.kind === 'refused' ? 409 : 502;
  return Response.json({ ok: false, refusal: explainContactFailure(result) }, { status, headers: NO_STORE });
}
