import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeLesson, isLessonOp, loadLesson } from '@/lib/academy/lessons-server';

/**
 * The Academy lesson editor (AC-course-structure-03).
 *
 *   GET ?itemId=<uuid>   one outline item's lesson: its revisions, newest first, and which one learners see
 *   POST { op: 'save', itemId, revision, blocks }   a new revision over the one read (0 when nothing is written)
 *   POST { op: 'revert', itemId, revision, toRevision }   a new revision with an older one's blocks
 *   POST { op: 'publish', itemId, lessonRevision, courseRevision, reason }   learners see this revision from now on
 *   POST { op: 'duplicate', itemId, courseRevision }   a copy of the item and its newest lesson, right after it
 *   POST { op: 'draft', itemId, revision, path: 'template' | 'model' }   an assistant draft; the model path refuses
 *        owner.decision while no provider is chosen
 *   POST { op: 'decide', itemId, basedOnRevision, kind: 'template', decision: 'accept' | 'discard' }   a person's call
 *   POST { op: 'import', itemId, revision, document }   a lesson file as a new revision; over the owner's size limit
 *        it is refused before it is read, and a bad block comes back in a report with nothing created
 *
 * Founder-only. svc-academy records the founder from their own token.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const LESSON_BODY_BYTES = 262_144;
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
  return Response.json(await loadLesson(session, itemId), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    // A lesson (and a lesson file) is a document, so this route takes up to 256 KiB rather than the console's 16 KiB.
    const body = await readAdminJson(request, LESSON_BODY_BYTES);
    if (!isLessonOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeLesson(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
