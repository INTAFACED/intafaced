import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeGrading, isGradingOp, loadGradingQueue } from '@/lib/academy/grading-server';

/**
 * The Academy grading queue (AC-assignments-02).
 *
 *   GET ?itemId=<uuid>   each learner's newest hand-in under an alias, its peer reviews, grade and grader lease
 *   POST { op: 'open', itemId, submissionId }   take or renew this founder's lease on one hand-in
 *   POST { op: 'grade', itemId, submissionId, n, score, comment, reason }   grade event n; an override needs a reason
 *   POST { op: 'bulk', itemId, fileName, csv }   a CSV of grades by alias; good rows apply, bad rows are listed
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
  return Response.json(await loadGradingQueue(session, itemId), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    // A grade file runs to 262,144 characters (up to four bytes each in UTF-8, capped by the edge's 1 MB body), so this
    // route takes up to 1 MB rather than the console's 16 KiB.
    const body = await readAdminJson(request, BODY_BYTES);
    if (!isGradingOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeGrading(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
