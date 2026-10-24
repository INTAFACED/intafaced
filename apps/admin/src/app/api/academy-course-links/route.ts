import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeLinks, isLinksOp, loadLinks } from '@/lib/academy/links-server';

/**
 * A course's private links (AC-catalogue-03).
 *
 *   GET ?courseId=<uuid>                       the course's links, newest first, without their keys
 *   POST { op: 'create', courseId, reason }    a link to the unlisted page; its customer app path (with the key) comes back once
 *   POST { op: 'revoke', linkId, reason }      the link stops opening the page
 *
 * Preview as new learner is its own page (/academy-ops/catalogue/courses/<id>/preview). Founder-only; svc-academy
 * records the founder from their own token.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const incomplete = (body: string) =>
  Response.json(
    {
      ok: false,
      title: 'That request is not complete',
      body,
      next: 'Nothing was changed. Correct it and try again.',
      code: null,
      changed: 'no',
    },
    { status: 400, headers: NO_STORE },
  );

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const courseId = new URL(request.url).searchParams.get('courseId') ?? '';
  if (!UUID.test(courseId)) return incomplete('Which course?');
  return Response.json(await loadLinks(session, courseId), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    if (!isLinksOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeLinks(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
