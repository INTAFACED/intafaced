import 'server-only';
import {
  ACADEMY_ADMIN_COURSE,
  ACADEMY_ADMIN_COURSES,
  ACADEMY_ADMIN_CREATE_COURSE,
  ACADEMY_ADMIN_DUPLICATE_COURSE,
  ACADEMY_ADMIN_SAVE_OUTLINE,
  ACADEMY_ADMIN_SET_COURSE_STATE,
  ACADEMY_ADMIN_SET_COURSE_TOPICS,
  ACADEMY_ADMIN_TOPICS,
  ACADEMY_ADMIN_UPDATE_COURSE,
} from '@intafaced/contracts/academy-admin-procedures';
import {
  academyCreateCourseInputSchema,
  academyDuplicateCourseInputSchema,
  academySaveOutlineInputSchema,
  academySetCourseStateInputSchema,
  academyUpdateCourseInputSchema,
  academySetCourseTopicsInputSchema,
  type AcademyCourse,
  type AcademyCourseDetail,
  type AcademySaveOutlineInput,
  type AcademySetCourseTopicsInput,
} from '@intafaced/contracts/academy-courses';
import { founderRecordCall, type FounderCallContext, type FounderCallResult, partFrom, type PartLabels, explainRefusal } from '@/lib/desk';
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

export async function loadCourseList(ctx: FounderCallContext): Promise<CourseListView> {
  const list = await founderRecordCall(ctx, ACADEMY_ADMIN_COURSES, { limit: COURSE_PAGE });
  return { list: partFrom(list, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

export async function loadCourseDetail(ctx: FounderCallContext, courseId: string): Promise<CourseDetailView> {
  const [detail, topics] = await Promise.all([
    founderRecordCall(ctx, ACADEMY_ADMIN_COURSE, { courseId }),
    founderRecordCall(ctx, ACADEMY_ADMIN_TOPICS, undefined),
  ]);
  return {
    detail: partFrom(detail, (d) => d, ACADEMY),
    topicChoices: partFrom(topics, (d) => d, ACADEMY),
    asOf: new Date().toISOString(),
  };
}

/** A change that answers with the whole course detail, read as the course it changed. */
const courseOf = (result: FounderCallResult<AcademyCourseDetail>): FounderCallResult<AcademyCourse> =>
  result.kind === 'ok' ? { ...result, data: result.data.course } : result;

/** AC-articles-01: the topics the course is filed under, as a whole. */
export function checkTopics(input: unknown): CheckedInput<AcademySetCourseTopicsInput> {
  const parsed = academySetCourseTopicsInputSchema.safeParse(input);
  return parsed.success
    ? { ok: true, input: parsed.data }
    : { ok: false, why: 'Which course, read at which revision, under which topics (up to 20)?' };
}

export async function saveTopics(ctx: FounderCallContext, input: AcademySetCourseTopicsInput) {
  return reply(courseOf(await founderRecordCall(ctx, ACADEMY_ADMIN_SET_COURSE_TOPICS, input)), 'topics saved');
}

function reply(result: FounderCallResult<AcademyCourse>, what: string): { status: number; reply: CourseDeskReply } {
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
  return reply(await founderRecordCall(ctx, ACADEMY_ADMIN_CREATE_COURSE, draft), 'created');
}

/** AC-course-structure-03: a draft copy of this course at its own address, with a reason. No learner record is copied. */
export function checkDuplicate(input: { courseId: string; slug: string; title: string; reason: string }) {
  const parsed = academyDuplicateCourseInputSchema.safeParse(input);
  return parsed.success ? ({ ok: true, input: parsed.data } as const) : ({ ok: false, why: why(parsed.error.issues) } as const);
}

export async function duplicateCourse(ctx: FounderCallContext, input: { courseId: string; slug: string; title: string; reason: string }) {
  return reply(await founderRecordCall(ctx, ACADEMY_ADMIN_DUPLICATE_COURSE, input), 'duplicated as a new draft');
}

export function checkUpdate(input: Omit<CourseDraftInput, 'slug'> & { courseId: string; revision: number }) {
  const parsed = academyUpdateCourseInputSchema.safeParse(input);
  return parsed.success ? ({ ok: true, input } as const) : ({ ok: false, why: why(parsed.error.issues) } as const);
}

export async function updateCourse(
  ctx: FounderCallContext,
  input: Omit<CourseDraftInput, 'slug'> & { courseId: string; revision: number },
) {
  return reply(await founderRecordCall(ctx, ACADEMY_ADMIN_UPDATE_COURSE, input), 'saved');
}

export function checkMove(input: { courseId: string; to: 'published'; revision: number; reason: string }) {
  const parsed = academySetCourseStateInputSchema.safeParse(input);
  return parsed.success ? ({ ok: true, input: parsed.data } as const) : ({ ok: false, why: why(parsed.error.issues) } as const);
}

export async function moveCourse(ctx: FounderCallContext, input: { courseId: string; to: 'published'; revision: number; reason: string }) {
  return reply(await founderRecordCall(ctx, ACADEMY_ADMIN_SET_COURSE_STATE, input), input.to);
}

/** An outline save: the outline's own shape is checked here as svc-academy checks it; the owner's limits are the service's. */
export function checkOutline(input: unknown): CheckedInput<AcademySaveOutlineInput> {
  const parsed = academySaveOutlineInputSchema.safeParse(input);
  if (parsed.success) return { ok: true, input: parsed.data };
  const path = parsed.error.issues[0]?.path ?? [];
  const last = path[path.length - 1];
  // The link rule is checked on the whole item, so its issue ends at the item's index (or at `url` for a bad address).
  const onItem = path.includes('items') && (last === 'url' || typeof last === 'number');
  return {
    ok: false,
    why: onItem
      ? 'A link item needs an https address, and no other item has one.'
      : last === 'title'
        ? 'Every section and item needs a title of up to 120 characters.'
        : last === 'indent'
          ? 'An item is indented 0 to 2 steps.'
          : last === 'kind'
            ? 'Each item is a lesson, video, file, quiz, assignment, discussion, link or subheader.'
            : 'Which course, read at which revision, with which sections?',
  };
}

export async function saveOutline(ctx: FounderCallContext, input: AcademySaveOutlineInput) {
  return reply(courseOf(await founderRecordCall(ctx, ACADEMY_ADMIN_SAVE_OUTLINE, input)), 'outline saved');
}
