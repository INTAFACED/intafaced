import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeTeam, isTeamOp, loadModeration } from '@/lib/academy/team-server';

/**
 * The moderation desk (J-academy-18, AC-rooms-02).
 *
 *   GET ?courseId=<uuid>   reported posts still showing, and every moderation action, on one course or all
 *   POST { op: 'deletePost', postId, reason } | { op: 'bulkDelete', courseId, authorId, reason }
 *
 * A read-only session (a support agent) reads the queue; svc-academy refuses a change from it, and from anyone whose roles
 * on the course do not permit moderation.
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
  const courseId = new URL(request.url).searchParams.get('courseId');
  if (courseId !== null && !UUID.test(courseId)) return incomplete('Which course?');
  return Response.json(await loadModeration(session, courseId ? courseId.toLowerCase() : null), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    if (!isTeamOp(body.op) || !(body.op === 'deletePost' || body.op === 'bulkDelete')) return incomplete('Unknown action.');
    const answer = await changeTeam(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
