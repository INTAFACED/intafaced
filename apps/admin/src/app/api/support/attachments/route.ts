import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { readAttachmentSetRequest } from '@/lib/support/attachments';
import { explainAttachmentFailure } from '@/lib/support/attachments-refusal';
import { loadAttachments, setAttachments } from '@/lib/support/attachments-server';

/**
 * Support attachment limits (SP-tickets-02). GET reads the five pieces an attach needs and the owner-set limits; POST sets one or more limits.
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
  return Response.json(await loadAttachments(session), { headers: NO_STORE });
}

const INVALID = {
  ok: false,
  refusal: {
    title: 'That request was not accepted',
    body: 'A change names the limits to set, the revision you read and a reason. Nothing was sent.',
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
  const change = readAttachmentSetRequest(raw);
  if (!change) return Response.json(INVALID, { status: 400, headers: NO_STORE });

  const result = await setAttachments(session, change);
  // The audit line names who changed which fields. It never carries the values or the reason.
  console.warn(
    JSON.stringify({
      audit: 'admin.support_attachments_set',
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
            next: 'Reload the limits before changing them again.',
            code: 'admin.ops_invalid_response',
            changed: 'unknown',
          },
        },
        { status: 502, headers: NO_STORE },
      );
    }
    return Response.json({ ok: true, limits: result.data }, { headers: NO_STORE });
  }
  const status = result.kind === 'forbidden' ? (result.refusal.status === 401 ? 401 : 403) : result.kind === 'refused' ? 409 : 502;
  return Response.json({ ok: false, refusal: explainAttachmentFailure(result) }, { status, headers: NO_STORE });
}
