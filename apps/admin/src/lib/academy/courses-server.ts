import 'server-only';
import {
  academyCourseDetailSchema,
  academyCourseListSchema,
  academyCourseSchema,
  academyCreateCourseInputSchema,
  academySaveOutlineInputSchema,
  academySetCourseStateInputSchema,
  academyUpdateCourseInputSchema,
  type AcademySaveOutlineInput,
} from '@intafaced/contracts/academy-courses';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { COURSE_PAGE, type CourseDeskReply, type CourseDetailView, type CourseDraftInput, type CourseListView } from './courses-model';

/**
 * The course desk as the signed-in founder. svc-academy holds the courses (`admin.courses`, `admin.course`) and records
 * the founder from their own token on every create, edit and move. No money moves: a price is a catalogue figure.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. The course desk needs the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readList = parseWith(academyCourseListSchema);
const readDetail = parseWith(academyCourseDetailSchema);
const readCourse = parseWith(academyCourseSchema);

export async function loadCourseList(ctx: FounderCallContext): Promise<CourseListView> {
  const list = await founderCall(ctx, 'academy', 'admin.courses', 'GET', { limit: COURSE_PAGE }, readList);
  return { list: partFrom(list, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

export async function loadCourseDetail(ctx: FounderCallContext, courseId: string): Promise<CourseDetailView> {
  const detail = await founderCall(ctx, 'academy', 'admin.course', 'GET', { courseId }, readDetail);
  return { detail: partFrom(detail, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

const readCourseOfDetail = (raw: unknown) => readDetail(raw)?.course ?? null;

function reply(result: FounderCallResult<ReturnType<typeof readCourse>>, what: string): { status: number; reply: CourseDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what, course: result.data } } : refused(null, 502, true);
    case 'refused':
      return refused(result.refusal.code, result.refusal.status);
    case 'forbidden':
      return refused(result.refusal.code ?? 'operator.denied', 403);
    case 'not_built':
      return refused('not_built', 501);
    case 'unavailable':
      return refused(null, 503, result.uncertain);
    case 'invalid':
      return refused(null, 502, true);
  }
}

/** The shapes are checked here as svc-academy checks them, so a form mistake is named before anything is sent. */
export type CheckedInput<T> = { ok: true; input: T } | { ok: false; why: string };

const why = (issues: readonly { path: readonly PropertyKey[] }[]): string => {
  const field = String(issues[0]?.path[0] ?? '');
  const sentences: Record<string, string> = {
    slug: 'The address must be 3 to 64 lower-case letters or digits, words joined by single hyphens.',
    title: 'The title is required, up to 120 characters.',
    summary: 'The summary is up to 1000 characters.',
    thumbnailUrl: 'The thumbnail must be an https address, or left blank.',
    price: 'A price is a number more than zero, with a point for decimals (25.50), and needs its asset.',
    priceAsset: 'The asset is a short upper-case code (USDT), given with the price.',
    reason: 'Say why, in up to 500 characters.',
  };
  return sentences[field] ?? 'A price comes with its asset, and only a paid course has one.';
};

export function checkCreate(draft: CourseDraftInput): CheckedInput<CourseDraftInput> {
  const parsed = academyCreateCourseInputSchema.safeParse(draft);
  return parsed.success ? { ok: true, input: draft } : { ok: false, why: why(parsed.error.issues) };
}

export async function createCourse(ctx: FounderCallContext, draft: CourseDraftInput) {
  return reply(await founderCall(ctx, 'academy', 'admin.createCourse', 'POST', draft, readCourse), 'created');
}

export function checkUpdate(input: Omit<CourseDraftInput, 'slug'> & { courseId: string; revision: number }) {
  const parsed = academyUpdateCourseInputSchema.safeParse(input);
  return parsed.success ? ({ ok: true, input } as const) : ({ ok: false, why: why(parsed.error.issues) } as const);
}

export async function updateCourse(
  ctx: FounderCallContext,
  input: Omit<CourseDraftInput, 'slug'> & { courseId: string; revision: number },
) {
  return reply(await founderCall(ctx, 'academy', 'admin.updateCourse', 'POST', input, readCourse), 'saved');
}

export function checkMove(input: { courseId: string; to: 'published'; revision: number; reason: string }) {
  const parsed = academySetCourseStateInputSchema.safeParse(input);
  return parsed.success ? ({ ok: true, input: parsed.data } as const) : ({ ok: false, why: why(parsed.error.issues) } as const);
}

export async function moveCourse(ctx: FounderCallContext, input: { courseId: string; to: 'published'; revision: number; reason: string }) {
  return reply(await founderCall(ctx, 'academy', 'admin.setCourseState', 'POST', input, readCourse), input.to);
}

/** An outline save: the outline's own shape is checked here as svc-academy checks it; the owner's limits are the service's. */
export function checkOutline(input: unknown): CheckedInput<AcademySaveOutlineInput> {
  const parsed = academySaveOutlineInputSchema.safeParse(input);
  if (parsed.success) return { ok: true, input: parsed.data };
  const path = parsed.error.issues[0]?.path ?? [];
  return {
    ok: false,
    why: path.includes('url')
      ? 'A link item needs an https address, and no other item has one.'
      : path.includes('items') || path.includes('sections')
        ? 'Every section and item needs a title of up to 120 characters.'
        : 'Which course, read at which revision?',
  };
}

export async function saveOutline(ctx: FounderCallContext, input: AcademySaveOutlineInput) {
  return reply(await founderCall(ctx, 'academy', 'admin.saveOutline', 'POST', input, readCourseOfDetail), 'outline saved');
}
