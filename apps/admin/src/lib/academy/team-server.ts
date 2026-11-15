import 'server-only';
import { academyCourseListSchema } from '@intafaced/contracts/academy-courses';
import {
  academyBulkDeleteUserPostsInputSchema,
  academyConfirmTeamChangeInputSchema,
  academyCourseTeamSchema,
  academyDeleteDiscussionPostInputSchema,
  academyModerationQueueSchema,
  academyModerationResultSchema,
  academyProposeTeamChangeInputSchema,
  academyRoleSchema,
  academyRolesSchema,
  academySaveCustomRoleInputSchema,
  academySetCustomRoleActiveInputSchema,
  academyTeamChangeSchema,
  ACADEMY_MODERATION_LIST_MAX,
} from '@intafaced/contracts/academy-team';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';
import type { ModerationView, TeamDeskReply, TeamView } from './team-model';

/**
 * The moderation desk and the course team desk as the signed-in operator. svc-academy records the operator from their own
 * token, checks their roles on the course on every change, and refuses a change from a session that may only read. No
 * money moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage: 'svc-academy did not accept your session. These desks need the Academy operator permission (admin:read).',
  refusedMessage: (code) => (code ? teamRefusal(code, 409).body : null),
};

/** These desks' own words for the codes they share with other desks; the rest come from the shared catalogue. */
const OWN_COPY: Record<string, Omit<RefusalView, 'code' | 'changed'>> = {
  'academy.reason_required': {
    title: 'A reason is required',
    body: 'Every deletion and every role change keeps who made it and why, so one with no reason is refused.',
    next: 'Say why, then try again. Nothing was changed.',
  },
  'academy.post_not_found': {
    title: 'That post is gone',
    body: 'The post was deleted already, or it is not a post on any course.',
    next: 'Read the queue again. Nothing was changed.',
  },
};

function teamRefusal(code: string | null, status: number, uncertain = false): RefusalView {
  const own = code ? OWN_COPY[code] : undefined;
  return own ? { ...own, code, changed: 'no' } : explainRefusal(code, status, uncertain);
}

const readQueue = parseWith(academyModerationQueueSchema);
const readCourses = parseWith(academyCourseListSchema);
const readTeam = parseWith(academyCourseTeamSchema);
const readRoles = parseWith(academyRolesSchema);
const readChange = parseWith(academyTeamChangeSchema);
const readRole = parseWith(academyRoleSchema);
const readModeration = parseWith(academyModerationResultSchema);

const coursesOf = (ctx: FounderCallContext) => founderCall(ctx, 'academy', 'admin.courses', 'GET', { limit: 500 }, readCourses);

export async function loadModeration(ctx: FounderCallContext, courseId: string | null): Promise<ModerationView> {
  const [queue, courses] = await Promise.all([
    founderCall(ctx, 'academy', 'admin.moderationQueue', 'GET', { courseId, limit: ACADEMY_MODERATION_LIST_MAX }, readQueue),
    coursesOf(ctx),
  ]);
  return {
    courseId,
    queue: partFrom(queue, (d) => d, ACADEMY),
    courses: partFrom(courses, (d) => d, ACADEMY),
    asOf: new Date().toISOString(),
  };
}

export async function loadTeam(ctx: FounderCallContext, courseId: string | null): Promise<TeamView> {
  const [team, roles, courses] = await Promise.all([
    founderCall(ctx, 'academy', 'admin.courseTeam', 'GET', { courseId }, readTeam),
    founderCall(ctx, 'academy', 'admin.academyRoles', 'GET', undefined, readRoles),
    coursesOf(ctx),
  ]);
  return {
    courseId,
    team: partFrom(team, (d) => d, ACADEMY),
    roles: partFrom(roles, (d) => d, ACADEMY),
    courses: partFrom(courses, (d) => d, ACADEMY),
    asOf: new Date().toISOString(),
  };
}

function reply(result: FounderCallResult<unknown>, what: string): { status: number; reply: TeamDeskReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...teamRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what } } : refused(null, 502, true);
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

const OPS = {
  deletePost: {
    procedure: 'admin.deleteDiscussionPost',
    schema: academyDeleteDiscussionPostInputSchema,
    parse: readModeration,
    what: 'post deleted',
    why: 'Which post, and why delete it (up to 500 characters)?',
  },
  bulkDelete: {
    procedure: 'admin.bulkDeleteUserPosts',
    schema: academyBulkDeleteUserPostsInputSchema,
    parse: readModeration,
    what: "the author's posts in this course deleted",
    why: 'Which course and author, and why delete their posts (up to 500 characters)?',
  },
  propose: {
    procedure: 'admin.proposeTeamChange',
    schema: academyProposeTeamChangeInputSchema,
    parse: readChange,
    what: 'role change proposed; it waits for a second founder',
    why: 'A role change needs an account id, a role, a reason of up to 500 characters and a request id.',
  },
  confirm: {
    procedure: 'admin.confirmTeamChange',
    schema: academyConfirmTeamChangeInputSchema,
    parse: readChange,
    what: 'role change confirmed',
    why: 'Which role change?',
  },
  saveRole: {
    procedure: 'admin.saveCustomRole',
    schema: academySaveCustomRoleInputSchema,
    parse: readRole,
    what: 'custom role saved',
    why: 'A custom role needs a name of 3 to 48 lower-case letters, digits and underscores (not a built-in role), at least one permission and a reason.',
  },
  setRoleActive: {
    procedure: 'admin.setCustomRoleActive',
    schema: academySetCustomRoleActiveInputSchema,
    parse: readRole,
    what: 'custom role switched',
    why: 'Which role, on or off, and why?',
  },
} as const;

export type TeamOp = keyof typeof OPS;
export const isTeamOp = (op: unknown): op is TeamOp => typeof op === 'string' && Object.hasOwn(OPS, op);

export async function changeTeam(
  ctx: FounderCallContext,
  op: TeamOp,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: TeamDeskReply } | { why: string }> {
  const { op: _op, ...input } = body;
  const spec = OPS[op];
  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) return { why: spec.why };
  let what: string = spec.what;
  if (op === 'setRoleActive') what = (parsed.data as { active: boolean }).active ? 'custom role switched on' : 'custom role switched off';
  return reply(await founderCall(ctx, 'academy', spec.procedure, 'POST', parsed.data, spec.parse as (raw: unknown) => unknown), what);
}
