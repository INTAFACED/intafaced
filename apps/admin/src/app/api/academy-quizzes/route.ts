import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeQuiz, isQuizOp, loadQuiz } from '@/lib/academy/quizzes-server';

/**
 * The Academy quiz editor (AC-quizzes-01).
 *
 *   GET ?itemId=<uuid>   a quiz item's questions, attempt rules, state, attempts and what stops Publish
 *   POST { op: 'save', itemId, revision, passMark, attemptLimit, scoringPolicy, timeLimitSeconds, reviewMode, ipAllow, accessCode?, questions }
 *   POST { op: 'setState', itemId, state, reason }   publish, or take back to draft while nobody has an attempt
 *
 * Founder-only. svc-academy records the founder from their own token and never sends an access code back.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const BODY_BYTES = 262_144;
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
  return Response.json(await loadQuiz(session, itemId), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    // A quiz runs to 100 questions of 20 choices, so this route takes up to 256 KiB rather than the console's 16 KiB.
    const body = await readAdminJson(request, BODY_BYTES);
    if (!isQuizOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeQuiz(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
