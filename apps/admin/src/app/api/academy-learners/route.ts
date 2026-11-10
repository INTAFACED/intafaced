import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeLearner, isLearnerOp, loadLearner } from '@/lib/academy/learners-server';

/**
 * One learner on the staff desk (J-academy-14).
 *
 *   GET ?userId=<uuid>   the profile and sign-in statistics (identity), and the access, enrolments, notes, tags,
 *                        progress and audit (svc-academy)
 *   POST { op, userId, ... }   one change with its reason: addNote, markComplete, voidAttempt, extension, grantAccess,
 *                        reinstate, tag, untag. svc-academy refuses a change from a session that may only read.
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
  const userId = new URL(request.url).searchParams.get('userId') ?? '';
  if (!UUID.test(userId)) return incomplete('Which learner?');
  return Response.json(await loadLearner(session, userId), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    if (!isLearnerOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeLearner(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
