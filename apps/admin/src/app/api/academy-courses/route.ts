import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { draftFrom } from '@/lib/academy/courses-model';
import {
  checkCreate,
  checkMove,
  checkUpdate,
  createCourse,
  loadCourseDetail,
  loadCourseList,
  moveCourse,
  updateCourse,
} from '@/lib/academy/courses-server';

/**
 * The Academy course desk (AC-course-structure-01).
 *
 *   GET                       the courses, newest first, with the count in each state
 *   GET ?courseId=<uuid>      one course with its history
 *   POST { op: 'create', slug, title, summary, thumbnailUrl, pricing, price, priceAsset }   a draft; keyed by its slug
 *   POST { op: 'update', courseId, revision, title, summary, thumbnailUrl, pricing, price, priceAsset }   over the revision read
 *   POST { op: 'move', courseId, to: 'published', revision, reason }   one lifecycle move with its reason
 *
 * Founder-only. svc-academy records the founder from their own token. No money moves: a price is a catalogue figure.
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

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const revisionOf = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const courseId = new URL(request.url).searchParams.get('courseId');
  if (courseId !== null) {
    if (!UUID.test(courseId)) return incomplete('Which course?');
    return Response.json(await loadCourseDetail(session, courseId), { headers: NO_STORE });
  }
  return Response.json(await loadCourseList(session), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    const send = ({ status, reply }: { status: number; reply: unknown }) => Response.json(reply, { status, headers: NO_STORE });
    switch (body.op) {
      case 'create': {
        const check = checkCreate(draftFrom(body));
        if (!check.ok) return incomplete(check.why);
        return send(await createCourse(session, check.input));
      }
      case 'update': {
        const revision = revisionOf(body.revision);
        if (!UUID.test(str(body.courseId)) || revision === null) return incomplete('Which course, read at which revision?');
        const { slug: _slug, ...details } = draftFrom(body);
        const check = checkUpdate({ ...details, courseId: str(body.courseId), revision });
        if (!check.ok) return incomplete(check.why);
        return send(await updateCourse(session, check.input));
      }
      case 'move': {
        const revision = revisionOf(body.revision);
        if (!UUID.test(str(body.courseId)) || revision === null || body.to !== 'published')
          return incomplete('Which course, read at which revision, and which move?');
        const check = checkMove({ courseId: str(body.courseId), to: 'published', revision, reason: str(body.reason) });
        if (!check.ok) return incomplete(check.why);
        return send(await moveCourse(session, check.input));
      }
      default:
        return incomplete('Unknown action.');
    }
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
