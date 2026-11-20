/**
 * J-academy-18: the course team and moderation procedures. The learner's report is on the main router; the rest are on
 * the admin router, behind `admin:read` (a read) or `admin:write` (a change) with module academy, and each change asks the
 * per-course role check (`course-team.ts`) before acting. A session that may only read (a support agent) reads the queue
 * and the team, is offered no delete, and a direct change from it is refused. The actor is always the caller's own id from
 * the edge-signed principal, never the body. No money moves.
 */
import {
  academyBulkDeleteUserPostsInputSchema,
  academyConfirmTeamChangeInputSchema,
  academyCourseTeamInputSchema,
  academyCourseTeamSchema,
  academyDeleteDiscussionPostInputSchema,
  academyModerationQueueInputSchema,
  academyModerationQueueSchema,
  academyModerationResultSchema,
  academyProposeTeamChangeInputSchema,
  academyReportDiscussionPostInputSchema,
  academyReportDiscussionPostResultSchema,
  academyRoleSchema,
  academyRolesSchema,
  academySaveCustomRoleInputSchema,
  academySetCustomRoleActiveInputSchema,
  academyTeamChangeSchema,
  scopedProcedure,
  type Context,
} from '@intafaced/contracts';
import type { AcademyService } from '../academy-service.js';

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

const read = () => scopedProcedure('admin:read', { module: 'academy' });
const write = () => scopedProcedure('admin:write', { module: 'academy' });

/** The caller as the role check sees them: their own id, and whether the session holds `admin:write`. */
const callerOf = (ctx: Context) => ({
  userId: ctx.principal!.userId,
  mayWrite: ctx.principal?.scopes.includes('admin:write') === true,
});

export function reportDiscussionProcedure(academy: AcademyService, guard: Guard) {
  return scopedProcedure('academy:write', { module: 'academy' })
    .input(academyReportDiscussionPostInputSchema)
    .output(academyReportDiscussionPostResultSchema)
    .mutation(({ input, ctx }) => guard(() => academy.moderation.report({ ...input, userId: ctx.principal!.userId, now: new Date() })));
}

export function teamProcedures(academy: AcademyService, guard: Guard) {
  return {
    /** AC-roles-01: every role with its permissions and holders, the permission list and the owner's custom role limit. */
    academyRoles: read()
      .output(academyRolesSchema)
      .query(() => guard(() => academy.team.roles())),

    /** AC-roles-01: a course's team (or the academy-wide team, `courseId: null`) and what the caller may do there. */
    courseTeam: read()
      .input(academyCourseTeamInputSchema)
      .output(academyCourseTeamSchema)
      .query(({ input, ctx }) => guard(() => academy.team.team(input.courseId, callerOf(ctx)))),

    /** AC-roles-01: one founder proposes giving or taking a role; it waits for a different founder. */
    proposeTeamChange: write()
      .input(academyProposeTeamChangeInputSchema)
      .output(academyTeamChangeSchema)
      .mutation(({ input, ctx }) => guard(() => academy.team.propose({ ...input, caller: callerOf(ctx), now: new Date() }))),

    /** AC-roles-01: a different founder confirms a waiting role change; it takes effect now. */
    confirmTeamChange: write()
      .input(academyConfirmTeamChangeInputSchema)
      .output(academyTeamChangeSchema)
      .mutation(({ input, ctx }) => guard(() => academy.team.confirm({ ...input, caller: callerOf(ctx), now: new Date() }))),

    /** AC-roles-01: a new custom role inside the owner's limit; blank refuses `academy.role_limit_unset`. */
    saveCustomRole: write()
      .input(academySaveCustomRoleInputSchema)
      .output(academyRoleSchema)
      .mutation(({ input, ctx }) => guard(() => academy.team.saveCustomRole({ ...input, caller: callerOf(ctx), now: new Date() }))),

    /** AC-roles-01: switch a custom role off (holders keep the row, the permissions stop) or on, with a reason. */
    setCustomRoleActive: write()
      .input(academySetCustomRoleActiveInputSchema)
      .output(academyRoleSchema)
      .mutation(({ input, ctx }) => guard(() => academy.team.setCustomRoleActive({ ...input, caller: callerOf(ctx), now: new Date() }))),

    /** AC-rooms-02: reported entries still showing and the moderation events; readable by a read-only session. */
    moderationQueue: read()
      .input(academyModerationQueueInputSchema)
      .output(academyModerationQueueSchema)
      .query(({ input, ctx }) => guard(() => academy.moderation.queue({ ...input, caller: callerOf(ctx) }))),

    /** AC-rooms-02: delete a post or reply with a reason; the author is told in their tray. */
    deleteDiscussionPost: write()
      .input(academyDeleteDiscussionPostInputSchema)
      .output(academyModerationResultSchema)
      .mutation(({ input, ctx }) =>
        guard(async () => ({ event: await academy.moderation.deletePost({ ...input, caller: callerOf(ctx), now: new Date() }) })),
      ),

    /** AC-rooms-02: delete every post and reply of one author in one course, with a reason; their posts elsewhere stay. */
    bulkDeleteUserPosts: write()
      .input(academyBulkDeleteUserPostsInputSchema)
      .output(academyModerationResultSchema)
      .mutation(({ input, ctx }) =>
        guard(async () => ({ event: await academy.moderation.bulkDelete({ ...input, caller: callerOf(ctx), now: new Date() }) })),
      ),
  };
}

export const TEAM_PROCEDURES = [
  'academyRoles',
  'courseTeam',
  'proposeTeamChange',
  'confirmTeamChange',
  'saveCustomRole',
  'setCustomRoleActive',
  'moderationQueue',
  'deleteDiscussionPost',
  'bulkDeleteUserPosts',
] as const;
