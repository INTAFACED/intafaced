import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { KB_ID, readKbAuthoringRequest } from '@/lib/support/kb-authoring';
import { loadKbAuthoring, runKbAuthoring } from '@/lib/support/kb-authoring-server';
import { explainSupportFailure } from '@/lib/support/refusal';

/**
 * Help-article authoring (SP-kb-01, SP-kb-02). GET reads the sections, templates and, with `?id=`, one article's history
 * and newest draft. POST saves a draft or moves one draft revision through review.
 *
 * Runs as the signed-in founder: svc-support takes the author and the approver from the verified session, and refuses the
 * author approving their own draft whatever this page shows.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('support');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const id = new URL(request.url).searchParams.get('id');
  if (id !== null && !KB_ID.test(id)) return Response.json({ code: 'admin.request_invalid' }, { status: 400, headers: NO_STORE });
  return Response.json(await loadKbAuthoring(session, id), { headers: NO_STORE });
}

const INVALID = {
  ok: false,
  refusal: {
    title: 'That request was not accepted',
    body: 'It did not name a known article action with valid fields, so nothing was sent.',
    next: 'Check the fields and try again.',
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
  const action = readKbAuthoringRequest(raw);
  if (!action) return Response.json(INVALID, { status: 400, headers: NO_STORE });
  const result = await runKbAuthoring(session, action);
  // The audit line names who did what to which article. It never carries the words written.
  console.warn(
    JSON.stringify({
      audit: `admin.support_kb_${action.action}`,
      at: new Date().toISOString(),
      founder: session.session.userId,
      target: action.id,
      outcome: result.kind,
    }),
  );
  if (result.kind !== 'ok') {
    const status = result.kind === 'forbidden' ? 403 : result.kind === 'refused' ? 409 : 502;
    return Response.json({ ok: false, refusal: explainSupportFailure(result) }, { status, headers: NO_STORE });
  }
  return Response.json({ ok: true, action: action.action, data: result.data }, { headers: NO_STORE });
}
