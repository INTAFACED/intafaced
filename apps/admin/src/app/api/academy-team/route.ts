import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeTeam, isTeamOp, loadTeam } from '@/lib/academy/team-server';

/**
 * The course team desk (J-academy-18, AC-roles-01).
 *
 *   GET ?courseId=<uuid>   the course's team (none: the academy-wide team), every role and the custom role limit
 *   POST { op: 'propose' | 'confirm' | 'saveRole' | 'setRoleActive', ... }
 *
 * A role change waits for a second founder; svc-academy checks the roles of each founder on the course.
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
  return Response.json(await loadTeam(session, courseId ? courseId.toLowerCase() : null), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    if (!isTeamOp(body.op) || !(body.op === 'propose' || body.op === 'confirm' || body.op === 'saveRole' || body.op === 'setRoleActive'))
      return incomplete('Unknown action.');
    const answer = await changeTeam(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
