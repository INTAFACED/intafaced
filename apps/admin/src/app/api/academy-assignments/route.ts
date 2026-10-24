import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeAssignment, isAssignmentOp, loadAssignment } from '@/lib/academy/assignments-server';

/**
 * The Academy assignment editor (AC-assignments-01).
 *
 *   GET ?itemId=<uuid>   an assignment item's brief, who saved it, and how many learners handed in
 *   POST { op: 'save', itemId, revision, instructions, points, dueAt, text, file }   the brief over the revision read
 *   POST { op: 'withdraw', itemId, reason }   learners can no longer hand in; the brief and every hand-in stay
 *   POST { op: 'saveReview', itemId, revision, peer, peerCount, self, criteria }   peer and self review steps and the rubric
 *
 * Founder-only. svc-academy records the founder from their own token.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const BODY_BYTES = 32_768;
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
  return Response.json(await loadAssignment(session, itemId), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    // Instructions run to 10,000 characters, so this route takes up to 32 KiB rather than the console's 16 KiB.
    const body = await readAdminJson(request, BODY_BYTES);
    if (!isAssignmentOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeAssignment(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
