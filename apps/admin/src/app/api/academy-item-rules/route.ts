import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeItemRules, isItemRulesOp, loadItemRules } from '@/lib/academy/item-rules-server';

/**
 * Prerequisites and learners' own due dates on a course staff made (AC-release-access-02).
 *
 *   GET ?courseId=<uuid>   each assignment and quiz with what it requires, and every learner's moved due date
 *   POST { op: 'setPrerequisites', courseId, itemId, prerequisiteIds, reason }   refused when it makes a cycle
 *   POST { op: 'grantExtension', courseId, itemId, userId, dueAt, reason }   one enrolled learner's later due date
 *
 * Founder-only. svc-academy records the founder from their own token.
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
  return Response.json(await loadItemRules(session, courseId), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    if (!isItemRulesOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeItemRules(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
