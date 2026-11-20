import { z } from 'zod';

/**
 * AC-roles-01 and AC-rooms-02 (J-academy-18): the course team and the moderation of a course's discussion.
 *
 * A role is a named set of permissions held by an account on one course, or across the whole academy. The built-in roles
 * are fixed here; a custom role is built from the same permission list, can be switched off without removing its holders
 * (they keep the row, the permissions stop), and the number of custom roles is an owner value with no default (blank
 * refuses `academy.role_limit_unset`). Roles narrow a founder session: a founder who holds no role on a course keeps the
 * founder scopes' full reach there; one who holds roles there may do only what those roles permit. Giving or taking a role
 * is a two-founder change: one founder proposes it, a different founder confirms it, and nobody may give a role that
 * permits more than they hold themselves (`academy.role_escalation`).
 *
 * A learner reports a post with a reason; the moderation queue lists reported posts. A moderator deletes a post with a
 * reason (a state move: the row stays for the record and leaves every learner read), or deletes one author's posts in one
 * course; each is an event with the actor and the reason, and the author is told in their notification tray. A support
 * agent (a read-only session) reads the queue and is offered no delete. No money moves.
 */

/** Every permission a role may carry. `refund.request` only authorises asking for a refund; no role code moves value. */
export const ACADEMY_PERMISSIONS = [
  'content.edit',
  'content.publish',
  'content.delete',
  'grade',
  'enrol',
  'reports',
  'certificates',
  'comments',
  'coaching',
  'refund.request',
  'financial.view',
  'discussion.moderate',
  'discussion.endorse',
  'discussion.assign',
  'roles.assign',
] as const;
export type AcademyPermission = (typeof ACADEMY_PERMISSIONS)[number];

export const ACADEMY_BUILTIN_ROLES = [
  'admin',
  'instructor',
  'author',
  'staff',
  'limited_staff',
  'data_researcher',
  'discussion_admin',
  'moderator',
  'community_ta',
] as const;
export type AcademyBuiltinRole = (typeof ACADEMY_BUILTIN_ROLES)[number];

/** What each built-in role permits. A limited-staff member reads progress and reports and cannot edit content. */
export const ACADEMY_BUILTIN_ROLE_PERMISSIONS: Readonly<Record<AcademyBuiltinRole, readonly AcademyPermission[]>> = {
  admin: ACADEMY_PERMISSIONS,
  instructor: [
    'content.edit',
    'content.publish',
    'content.delete',
    'grade',
    'enrol',
    'reports',
    'certificates',
    'comments',
    'coaching',
    'discussion.moderate',
    'discussion.endorse',
    'discussion.assign',
    'roles.assign',
  ],
  author: ['content.edit', 'content.publish', 'content.delete', 'reports', 'discussion.assign'],
  staff: ['content.edit', 'grade', 'enrol', 'reports', 'comments', 'coaching', 'discussion.moderate', 'discussion.endorse'],
  limited_staff: ['reports'],
  data_researcher: ['reports'],
  discussion_admin: ['discussion.moderate', 'discussion.endorse', 'discussion.assign'],
  moderator: ['discussion.moderate', 'discussion.endorse'],
  community_ta: ['discussion.endorse'],
};

/** The discussion roles: `discussion.assign` alone is enough to give or take one of these. */
export const ACADEMY_DISCUSSION_ROLES: readonly AcademyBuiltinRole[] = ['discussion_admin', 'moderator', 'community_ta'];

const reason = z.string().trim().max(500);
const requestId = z.string().trim().min(1).max(200);
/** A custom role's name: lower case words joined by `_`, never a built-in role's name. */
export const academyCustomRoleNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(48)
  .regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/)
  .refine((n) => !(ACADEMY_BUILTIN_ROLES as readonly string[]).includes(n), { message: 'that name is a built-in role' });

/** A role as it is named on the wire: a built-in role's name, or `custom:<uuid>`. */
export const academyRoleRefSchema = z.union([z.enum(ACADEMY_BUILTIN_ROLES), z.string().regex(/^custom:[0-9a-f-]{36}$/)]);
export type AcademyRoleRef = z.infer<typeof academyRoleRefSchema>;

export const academyRoleSchema = z.object({
  ref: z.string(),
  name: z.string(),
  kind: z.enum(['builtin', 'custom']),
  permissions: z.array(z.enum(ACADEMY_PERMISSIONS)),
  active: z.boolean(),
  holders: z.number().int().nonnegative(),
});
export type AcademyRole = z.infer<typeof academyRoleSchema>;

/** `admin.academyRoles`: every role, the permission list, and the owner's custom role limit (null while blank). */
export const academyRolesSchema = z.object({
  roles: z.array(academyRoleSchema),
  permissions: z.array(z.enum(ACADEMY_PERMISSIONS)),
  customRoleLimit: z.number().int().positive().nullable(),
  customRoles: z.number().int().nonnegative(),
});
export type AcademyRoles = z.infer<typeof academyRolesSchema>;

/** `admin.saveCustomRole`: a new custom role. A retry with the same request id answers with the stored role. */
export const academySaveCustomRoleInputSchema = z
  .object({
    name: academyCustomRoleNameSchema,
    permissions: z.array(z.enum(ACADEMY_PERMISSIONS)).min(1).max(ACADEMY_PERMISSIONS.length),
    reason,
    requestId,
  })
  .strict();
export type AcademySaveCustomRoleInput = z.infer<typeof academySaveCustomRoleInputSchema>;

/** `admin.setCustomRoleActive`: switch a custom role off (its holders keep the row) or on again, with a reason. */
export const academySetCustomRoleActiveInputSchema = z.object({ roleId: z.string().guid(), active: z.boolean(), reason }).strict();

/** A course's team: who holds which role, the changes waiting for a second founder, and every change made. */
export const academyTeamHolderSchema = z.object({
  accountId: z.string().guid(),
  role: z.string(),
  roleName: z.string(),
  active: z.boolean(),
  since: z.coerce.date(),
});
export const academyTeamChangeSchema = z.object({
  id: z.string().guid(),
  kind: z.enum(['assign', 'revoke']),
  accountId: z.string().guid(),
  role: z.string(),
  roleName: z.string(),
  reason: z.string(),
  proposedBy: z.string().guid(),
  proposedAt: z.coerce.date(),
  state: z.enum(['pending', 'confirmed']),
  confirmedBy: z.string().guid().nullable(),
  confirmedAt: z.coerce.date().nullable(),
});
export type AcademyTeamChange = z.infer<typeof academyTeamChangeSchema>;
export const academyCourseTeamSchema = z.object({
  /** null: the academy-wide team. */
  courseId: z.string().guid().nullable(),
  holders: z.array(academyTeamHolderSchema),
  changes: z.array(academyTeamChangeSchema),
  /** What the caller may do on this course, as the service will check it. */
  yourPermissions: z.array(z.enum(ACADEMY_PERMISSIONS)),
  /** True when the caller holds a role here, so their founder reach is narrowed to it. */
  narrowed: z.boolean(),
});
export type AcademyCourseTeam = z.infer<typeof academyCourseTeamSchema>;
export const academyCourseTeamInputSchema = z.object({ courseId: z.string().guid().nullable() }).strict();

/** `admin.proposeTeamChange`: give or take a role; it waits until a different founder confirms it. */
export const academyProposeTeamChangeInputSchema = z
  .object({
    courseId: z.string().guid().nullable(),
    accountId: z.string().guid(),
    role: academyRoleRefSchema,
    kind: z.enum(['assign', 'revoke']),
    reason,
    requestId,
  })
  .strict();
export type AcademyProposeTeamChangeInput = z.infer<typeof academyProposeTeamChangeInputSchema>;
export const academyConfirmTeamChangeInputSchema = z.object({ changeId: z.string().guid() }).strict();

// ── Moderation ───────────────────────────────────────────────────────────────

/** `reportDiscussionPost`: a learner reports a post or reply with a reason; a repeat by the same account changes nothing. */
export const academyReportDiscussionPostInputSchema = z
  .object({ postId: z.string().guid(), reason: z.string().trim().min(1).max(500) })
  .strict();
export const academyReportDiscussionPostResultSchema = z.object({
  postId: z.string().guid(),
  /** False when this account had already reported it: the first report stands. */
  reported: z.boolean(),
});

export const academyModerationReportSchema = z.object({
  postId: z.string().guid(),
  courseId: z.string().guid(),
  courseSlug: z.string(),
  courseTitle: z.string(),
  /** The post this entry is, or the post a reported reply belongs to. */
  threadId: z.string().guid(),
  isReply: z.boolean(),
  title: z.string().nullable(),
  body: z.string(),
  authorId: z.string().guid(),
  anonymous: z.boolean(),
  postedAt: z.coerce.date(),
  reports: z.number().int().positive(),
  reasons: z.array(z.string()),
  firstReportedAt: z.coerce.date(),
  /** True when the caller may delete this post: a session with `admin:write` whose roles on the course permit moderation. */
  mayModerate: z.boolean(),
});
export type AcademyModerationReport = z.infer<typeof academyModerationReportSchema>;

export const ACADEMY_MODERATION_ACTIONS = ['delete', 'bulk_delete'] as const;
export const academyModerationEventSchema = z.object({
  id: z.string().guid(),
  courseId: z.string().guid(),
  action: z.enum(ACADEMY_MODERATION_ACTIONS),
  /** The post deleted; null for a bulk delete. */
  postId: z.string().guid().nullable(),
  authorId: z.string().guid(),
  posts: z.number().int().nonnegative(),
  actorId: z.string().guid(),
  reason: z.string(),
  recordedAt: z.coerce.date(),
});
export type AcademyModerationEvent = z.infer<typeof academyModerationEventSchema>;

export const ACADEMY_MODERATION_LIST_MAX = 200;
/** `admin.moderationQueue`: open reports on posts still showing, oldest report first, and the moderation events newest first. */
export const academyModerationQueueInputSchema = z
  .object({ courseId: z.string().guid().nullable(), limit: z.number().int().min(1).max(ACADEMY_MODERATION_LIST_MAX) })
  .strict();
export const academyModerationQueueSchema = z.object({
  reports: z.array(academyModerationReportSchema),
  events: z.array(academyModerationEventSchema),
  /** False on a session that may only read: the desk offers no delete. */
  mayWrite: z.boolean(),
});
export type AcademyModerationQueue = z.infer<typeof academyModerationQueueSchema>;

/** `admin.deleteDiscussionPost`: the post (and, for a post, its replies) leave every learner read; the author is told. */
export const academyDeleteDiscussionPostInputSchema = z.object({ postId: z.string().guid(), reason }).strict();
/** `admin.bulkDeleteUserPosts`: every post and reply of one author in one course; their posts elsewhere stay. */
export const academyBulkDeleteUserPostsInputSchema = z
  .object({ courseId: z.string().guid(), authorId: z.string().guid(), reason })
  .strict();
export const academyModerationResultSchema = z.object({ event: academyModerationEventSchema });
