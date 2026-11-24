import 'server-only';
import {
  academyCourseReleaseSchema,
  academySetCoursePacingInputSchema,
  academySetSectionReleaseInputSchema,
} from '@intafaced/contracts/academy-course-release';
import {
  parseWith,
  type FounderCallContext,
  type FounderCallResult,
  partFrom,
  type PartLabels,
  explainRefusal,
  founderRecordRead,
} from '@/lib/desk';
import type { AcademyCourseRelease, ReleaseDeskReply, ReleaseView } from './release-model';
import {
  ACADEMY_ADMIN_COURSE_RELEASE,
  ACADEMY_ADMIN_SET_SECTION_RELEASE,
  ACADEMY_ADMIN_SET_COURSE_PACING,
} from '@intafaced/contracts/academy-admin-records';

/**
 * A course's pacing and section release as the signed-in founder (AC-release-access-01). svc-academy records the founder
 * from their own token with the reason on every change, and refuses a pacing change once a learner has enrolled. No money
 * moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage:
    'svc-academy did not accept your founder session. Release and pacing need the Academy operator permission (admin:read, admin:write).',
  refusedMessage: (code) => (code ? explainRefusal(code, 409).body : null),
};

const readRelease = parseWith(academyCourseReleaseSchema);

export async function loadRelease(ctx: FounderCallContext, courseId: string): Promise<ReleaseView> {
  const release = partFrom(await founderRecordRead(ctx, ACADEMY_ADMIN_COURSE_RELEASE, { courseId }, readRelease), (d) => d, ACADEMY);
  return { release, asOf: new Date().toISOString() };
}

function reply(result: FounderCallResult<AcademyCourseRelease | null>, what: string): { status: number; reply: ReleaseDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...explainRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what, release: result.data } } : refused(null, 502, true);
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

/** What the founder sent, checked as svc-academy checks it, so a form mistake is named before anything is sent. */
const OPS = {
  setSectionRelease: {
    schema: academySetSectionReleaseInputSchema,
    record: ACADEMY_ADMIN_SET_SECTION_RELEASE,
    what: 'section release saved',
    why: 'A section opens with the course, at a date and time, or 1 to 365 whole days after each learner enrols. Say why in up to 500 characters.',
  },
  setPacing: {
    schema: academySetCoursePacingInputSchema,
    record: ACADEMY_ADMIN_SET_COURSE_PACING,
    what: 'pacing saved',
    why: 'Choose self-paced or instructor-paced, and say why in up to 500 characters.',
  },
} as const;

export type ReleaseOp = keyof typeof OPS;
export const isReleaseOp = (op: unknown): op is ReleaseOp => typeof op === 'string' && Object.hasOwn(OPS, op);

export async function changeRelease(
  ctx: FounderCallContext,
  op: ReleaseOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: ReleaseDeskReply } | { why: string }> {
  const spec = OPS[op];
  const { op: _op, ...input } = body;
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) return { why: spec.why };
  return reply(await founderRecordRead(ctx, spec.record, parsed.data, readRelease), spec.what);
}
