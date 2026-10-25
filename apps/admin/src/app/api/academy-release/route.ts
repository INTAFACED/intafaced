import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeRelease, isReleaseOp, loadRelease } from '@/lib/academy/release-server';

/**
 * Release and pacing of a course staff made (AC-release-access-01).
 *
 *   GET ?courseId=<uuid>   the course's pacing, whether it is locked, and each section's release rule with who and why
 *   POST { op: 'setSectionRelease', courseId, sectionId, rule, reason }   rule is { kind: 'at', at } or
 *        { kind: 'after_enrolment', days }, or null to open the section with the course
 *   POST { op: 'setPacing', courseId, pacing, reason }   while no learner has enrolled
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
  return Response.json(await loadRelease(session, courseId), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    if (!isReleaseOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeRelease(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
