import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeQuizTrail, isQuizTrailOp, loadQuizTrail } from '@/lib/academy/quiz-trail-server';

/**
 * A quiz's attempts and score changes (AC-quizzes-04).
 *
 *   GET ?itemId=<uuid>   the quiz and every finished attempt under an alias, with points per question and its score trail
 *   POST { op: 'fixKey', itemId, revision, questions, reason }   a new revision that changes only keys
 *   POST { op: 'rescore', itemId, reason }   apply the current keys to each graded attempt they change
 *   POST { op: 'override', itemId, attemptId, questionId, points, n, comment, reason }   one question's points
 *   POST { op: 'curve', itemId, fileName, csv, dryRun, reason }   a curve file by alias; a dry run writes nothing
 *   POST { op: 'answers', itemId }   answers learner by learner (needs the data researcher role)
 *
 * Founder-only. svc-academy records the founder from their own token.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const BODY_BYTES = 1_000_000;
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
  const itemId = new URL(request.url).searchParams.get('itemId') ?? '';
  if (!UUID.test(itemId)) return incomplete('Which item?');
  return Response.json(await loadQuizTrail(session, itemId), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    // A curve file runs to 900,000 characters (svc-academy then holds it to the owner's byte limit), so this route takes a
    // body to 1,000,000 bytes, under the edge's 1 MiB.
    const body = await readAdminJson(request, BODY_BYTES);
    if (!isQuizTrailOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeQuizTrail(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
