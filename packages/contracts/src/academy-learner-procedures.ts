import { z } from 'zod';
import {
  ACADEMY_CURRICULUM_KINDS,
  ACADEMY_CURRICULUM_PATHS,
  academyAddTodoInputSchema,
  academyCourseProgressAddsUp,
  academyCurriculumSummarySchema,
  academyGoalReminderSchema,
  academyGoalSchema,
  academyItemCompletionSchema,
  academyPlannerSchema,
  academyPlannerTodoSchema,
  academyProgressPageSchema,
  academyQuizAttemptSchema,
  academyQuizReviewSchema,
  type AcademyProgressPage,
  academyRemoveTodoInputSchema,
  academySetGoalInputSchema,
  academySetTodoDoneInputSchema,
} from './academy-catalogue.js';
import {
  academyAcceptDiscussionReplyInputSchema,
  academyCreateDiscussionPostInputSchema,
  academyDiscussionAcceptResultSchema,
  academyDiscussionCourseSchema,
  academyDiscussionCoursesInputSchema,
  academyDiscussionFollowResultSchema,
  academyDiscussionImageSchema,
  academyDiscussionLikeResultSchema,
  academyDiscussionPostImageInputSchema,
  academyDiscussionPostSchema,
  academyDiscussionPostsInputSchema,
  academyDiscussionReplySchema,
  academyDiscussionThreadInputSchema,
  academyDiscussionThreadSchema,
  academyDiscussionToggleInputSchema,
  academyDiscussionTopicsInputSchema,
  academyDiscussionTopicsSchema,
  academyReplyDiscussionPostInputSchema,
} from './academy-discussion.js';
import { academyCertIssueSchema } from './academy-certificates.js';
import { academyReportDiscussionPostInputSchema, academyReportDiscussionPostResultSchema } from './academy-team.js';
import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';
import { unsignedAmountSchema } from './wire-amount.js';

/**
 * The learner's calls to svc-academy from the customer app: rooms and seats, course discussions, the reader and its
 * certificates, quizzes, and the progress page and planner. svc-academy's Rust door (`crates/svc-academy/src/door/`) is
 * the truth of the wire: each record's path, kind and scope are its `calls.rs` row, and each input is its
 * `schemas.json` tree. A scoped call is guarded by `scopedProcedure(scope, { module: 'academy' })`.
 *
 * Refusals are the academy codes a guarded handler can send, read from the Rust slice that answers the call. Codes the
 * door sends as INTERNAL_SERVER_ERROR (`academy.stake_unavailable`, `academy.stream_unavailable`,
 * `academy.host_rights_unavailable`) are failures, not named refusals, and are not listed. An unguarded call
 * (`rooms`, `certDefinitions`) sends every refusal as a 500, so it names none.
 */

const READ = { caller: 'scope', scope: 'academy:read', module: 'academy' } as const;
const WRITE = { caller: 'scope', scope: 'academy:write', module: 'academy' } as const;
const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

const refuse = (codes: Readonly<Record<string, RefusalStatus>> = {}): Refusals => Object.freeze({ ...codes });

const ID = '22222222-2222-4222-8222-222222222222';
const uuid = z.guid();
const ref = z.string().min(1);

// ── Rooms ────────────────────────────────────────────────────────────────────

/** The room kinds svc-academy holds (`roomKind`). */
export const ACADEMY_ROOM_KINDS = ['general', 'futures', 'options', 'meme_war_room', 'forex', 'defi_lab', 'merchant_clinic'] as const;
const roomKind = z.enum(ACADEMY_ROOM_KINDS);

/** One room as the customer app reads it. */
export const academyRoomSchema = z.object({
  id: uuid,
  slug: z.string(),
  name: z.string(),
  kind: z.string(),
  access: z.enum(['free', 'staked', 'invite']),
  /** An exact decimal of zero or more: the rooms' `accept` holds it to `unsignedAmountSchema`. */
  minStake: z.string(),
  capacity: z.number().int().positive(),
  hostId: uuid,
});
export type AcademyRoom = z.infer<typeof academyRoomSchema>;

const vec = z.object({ x: z.number().finite(), y: z.number().finite() });
/** Scene v1 as the customer app reads it: strict at the top, as svc-academy's `sceneV1Schema` is. */
export const academySceneSchema = z
  .object({
    version: z.literal(1),
    stage: z
      .object({ width: z.number().positive().max(10000), height: z.number().positive().max(10000), backgroundKey: z.string().optional() })
      .optional(),
    avatars: z
      .array(
        z.object({
          id: z.string(),
          participantId: z.string(),
          position: vec,
          facing: z.number().optional(),
          labelKey: z.string().optional(),
        }),
      )
      .max(200)
      .optional(),
    props: z
      .array(z.object({ id: z.string(), kind: z.string(), position: vec, rotation: z.number().optional() }))
      .max(500)
      .optional(),
  })
  .strict();
export type AcademyScene = z.infer<typeof academySceneSchema>;

const stakeIsAmount = (room: { minStake: string }) => unsignedAmountSchema.safeParse(room.minStake).success;
const STAKE_SAYS = "every room's minStake is an unsigned exact decimal (`unsignedAmountSchema`)";

const ROOM_LISTS = { 'academy.room_not_found': 'NOT_FOUND' } as const;
const SESSION = { 'academy.session_not_found': 'NOT_FOUND', 'academy.session_not_live': 'CONFLICT' } as const;
const SEAT = {
  'academy.room_full': 'CONFLICT',
  'academy.stake_required': 'FORBIDDEN',
  'academy.invite_required': 'FORBIDDEN',
} as const;

/** The open rooms, optionally of one kind. The page size is the caller's; unguarded, so it names no refusal. */
export const ACADEMY_ROOMS = defineProcedure({
  ...base,
  name: 'academy.rooms',
  kind: 'query',
  path: 'rooms',
  access: READ,
  refusals: refuse(),
  input: z.object({ kind: roomKind.optional(), limit: z.number().optional() }).optional(),
  output: z.array(academyRoomSchema),
  accept: { stakeIsAmount: { says: STAKE_SAYS, holds: (rooms) => (rooms as AcademyRoom[]).every(stakeIsAmount) } },
  samples: [
    { verdict: 'accept' },
    { verdict: 'accept', input: { limit: 50, kind: 'forex' } },
    { verdict: 'refuse', input: { kind: 'casino' } },
  ],
});

/** One session and how many hold a seat, with its scene as Scene v1 (the scene panel reads nothing else). */
export const ACADEMY_SESSION = defineProcedure({
  ...base,
  name: 'academy.session',
  kind: 'query',
  path: 'session',
  access: READ,
  refusals: refuse(SESSION),
  input: z.object({ sessionId: uuid }),
  output: z.object({
    session: z.object({
      id: uuid,
      roomId: uuid,
      title: z.string(),
      hostId: uuid,
      status: z.enum(['scheduled', 'live', 'ended', 'cancelled']),
      startsAt: z.string(),
      endsAt: z.string().nullable(),
      streamProvider: z.string().nullable(),
      scene: academySceneSchema,
      sceneFingerprint: z.string().min(1),
    }),
    occupancy: z.number().int().nonnegative(),
  }),
  samples: [
    { verdict: 'accept', input: { sessionId: ID } },
    { verdict: 'refuse', input: { sessionId: 'not-an-id' } },
  ],
});

/** Take a seat in a live session: the service enforces capacity, invitations and the stake threshold. */
export const ACADEMY_JOIN = defineProcedure({
  ...base,
  name: 'academy.join',
  kind: 'mutation',
  path: 'join',
  access: WRITE,
  refusals: refuse({ ...ROOM_LISTS, ...SESSION, ...SEAT }),
  input: z.object({ sessionId: uuid }),
  output: z.object({ role: z.enum(['host', 'speaker', 'attendee']) }),
  samples: [
    { verdict: 'accept', input: { sessionId: ID } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Give up the seat; leaving a seat one does not hold answers the same. */
export const ACADEMY_LEAVE = defineProcedure({
  ...base,
  name: 'academy.leave',
  kind: 'mutation',
  path: 'leave',
  access: WRITE,
  refusals: refuse(),
  input: z.object({ sessionId: uuid }),
  output: z.object({ ok: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { sessionId: ID } },
    { verdict: 'refuse', input: { sessionId: 7 } },
  ],
});

/** Open a room. A stake threshold is an access rule only: creating the room moves nothing. */
export const ACADEMY_CREATE_ROOM = defineProcedure({
  ...base,
  name: 'academy.createRoom',
  kind: 'mutation',
  path: 'createRoom',
  access: WRITE,
  refusals: refuse({
    'academy.host_rights_required': 'FORBIDDEN',
    'academy.room_capacity_unset': 'PRECONDITION_FAILED',
    'academy.room_full': 'CONFLICT',
    'academy.stake_required': 'FORBIDDEN',
  }),
  input: z.object({
    slug: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9-]+$/, 'a slug is lowercase letters, digits and hyphens'),
    name: z.string().min(1).max(120),
    kind: roomKind,
    access: z.enum(['free', 'staked', 'invite']),
    minStake: z
      .string()
      .regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings (max 18dp)')
      .optional(),
    capacity: z.number().int().min(1),
  }),
  output: academyRoomSchema,
  accept: { stakeIsAmount: { says: STAKE_SAYS, holds: (room) => stakeIsAmount(room as AcademyRoom) } },
  samples: [
    { verdict: 'accept', input: { slug: 'futures-desk', name: 'Futures desk', kind: 'futures', access: 'free', capacity: 20 } },
    { verdict: 'accept', input: { slug: 'whales', name: 'Whales', kind: 'general', access: 'staked', minStake: '10.5', capacity: 5 } },
    { verdict: 'refuse', input: { slug: 'Futures Desk', name: 'Futures desk', kind: 'futures', access: 'free', capacity: 20 } },
    { verdict: 'refuse', input: { slug: 'futures-desk', name: 'Futures desk', kind: 'futures', access: 'free', capacity: 0 } },
  ],
});

// ── Course discussions ───────────────────────────────────────────────────────

const COURSE = { 'academy.course_not_found': 'NOT_FOUND', 'academy.enrolment_required': 'FORBIDDEN' } as const;
const POST = { 'academy.post_not_found': 'NOT_FOUND', 'academy.conversation_not_found': 'NOT_FOUND' } as const;
const WRITING = {
  'academy.post_limit_unset': 'PRECONDITION_FAILED',
  'academy.post_too_long': 'BAD_REQUEST',
  'academy.request_reused': 'CONFLICT',
} as const;
const SLUG = 'intro-to-markets';

/** The published courses the reader is enrolled in, each a way into its discussion. */
export const ACADEMY_DISCUSSION_COURSES = defineProcedure({
  ...base,
  name: 'academy.discussionCourses',
  kind: 'query',
  path: 'discussionCourses',
  access: READ,
  refusals: refuse(),
  input: academyDiscussionCoursesInputSchema,
  output: z.array(academyDiscussionCourseSchema),
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'refuse', input: { limit: 0 } },
    { verdict: 'refuse', input: { limit: 50, extra: 1 } },
  ],
});

/** One course's discussion topics. */
export const ACADEMY_DISCUSSION_TOPICS = defineProcedure({
  ...base,
  name: 'academy.discussionTopics',
  kind: 'query',
  path: 'discussionTopics',
  access: READ,
  refusals: refuse(COURSE),
  input: academyDiscussionTopicsInputSchema,
  output: academyDiscussionTopicsSchema,
  samples: [
    { verdict: 'accept', input: { courseSlug: SLUG } },
    { verdict: 'refuse', input: { courseSlug: 'x' } },
  ],
});

/** One topic's posts, newest activity first. */
export const ACADEMY_DISCUSSION_POSTS = defineProcedure({
  ...base,
  name: 'academy.discussionPosts',
  kind: 'query',
  path: 'discussionPosts',
  access: READ,
  refusals: refuse({ ...COURSE, 'academy.topic_not_found': 'NOT_FOUND' }),
  input: academyDiscussionPostsInputSchema,
  output: z.array(academyDiscussionPostSchema),
  samples: [
    { verdict: 'accept', input: { courseSlug: SLUG, topicSlug: 'general', limit: 50 } },
    { verdict: 'refuse', input: { courseSlug: SLUG, topicSlug: 'general', limit: 201 } },
  ],
});

/** One post and its replies. */
export const ACADEMY_DISCUSSION_THREAD = defineProcedure({
  ...base,
  name: 'academy.discussionThread',
  kind: 'query',
  path: 'discussionThread',
  access: READ,
  refusals: refuse(POST),
  input: academyDiscussionThreadInputSchema,
  output: academyDiscussionThreadSchema,
  samples: [
    { verdict: 'accept', input: { postId: ID, limit: 100 } },
    { verdict: 'refuse', input: { postId: ID } },
  ],
});

/** A post's image, read on its own; null when it has none. */
export const ACADEMY_DISCUSSION_POST_IMAGE = defineProcedure({
  ...base,
  name: 'academy.discussionPostImage',
  kind: 'query',
  path: 'discussionPostImage',
  access: READ,
  refusals: refuse(),
  input: academyDiscussionPostImageInputSchema,
  output: academyDiscussionImageSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { postId: ID } },
    { verdict: 'refuse', input: { postId: 'post' } },
  ],
});

/** A new question or discussion in a topic; the client request id makes a retry the same post. */
export const ACADEMY_CREATE_DISCUSSION_POST = defineProcedure({
  ...base,
  name: 'academy.createDiscussionPost',
  kind: 'mutation',
  path: 'createDiscussionPost',
  access: WRITE,
  refusals: refuse({
    ...COURSE,
    ...POST,
    ...WRITING,
    'academy.topic_not_found': 'NOT_FOUND',
    'academy.attachment_limit_unset': 'PRECONDITION_FAILED',
    'academy.attachment_too_large': 'BAD_REQUEST',
    'academy.attachment_type_refused': 'BAD_REQUEST',
  }),
  input: academyCreateDiscussionPostInputSchema,
  output: academyDiscussionPostSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        courseSlug: SLUG,
        topicSlug: 'general',
        kind: 'question',
        title: 'How is funding paid?',
        body: 'Every eight hours?',
        anonymous: false,
        image: null,
        clientRequestId: 'post:1',
      },
    },
    {
      verdict: 'refuse',
      input: {
        courseSlug: SLUG,
        topicSlug: 'general',
        kind: 'poll',
        title: 'T',
        body: 'B',
        anonymous: false,
        image: null,
        clientRequestId: 'p',
      },
    },
  ],
});

/** A reply to a post; replies nest one level. */
export const ACADEMY_REPLY_DISCUSSION_POST = defineProcedure({
  ...base,
  name: 'academy.replyDiscussionPost',
  kind: 'mutation',
  path: 'replyDiscussionPost',
  access: WRITE,
  refusals: refuse({ ...POST, ...WRITING }),
  input: academyReplyDiscussionPostInputSchema,
  output: academyDiscussionReplySchema,
  samples: [
    { verdict: 'accept', input: { postId: ID, body: 'Yes, every eight hours.', anonymous: true, clientRequestId: 'reply:1' } },
    { verdict: 'refuse', input: { postId: ID, body: '', anonymous: true, clientRequestId: 'reply:1' } },
  ],
});

/** Follow a post or stop following it; a repeat changes nothing. */
export const ACADEMY_FOLLOW_DISCUSSION_POST = defineProcedure({
  ...base,
  name: 'academy.followDiscussionPost',
  kind: 'mutation',
  path: 'followDiscussionPost',
  access: WRITE,
  refusals: refuse(POST),
  input: academyDiscussionToggleInputSchema,
  output: academyDiscussionFollowResultSchema,
  samples: [
    { verdict: 'accept', input: { postId: ID, on: true } },
    { verdict: 'refuse', input: { postId: ID, on: 'yes' } },
  ],
});

/** Like a post or a reply, or take the like back; a repeat changes nothing. */
export const ACADEMY_LIKE_DISCUSSION_POST = defineProcedure({
  ...base,
  name: 'academy.likeDiscussionPost',
  kind: 'mutation',
  path: 'likeDiscussionPost',
  access: WRITE,
  refusals: refuse(),
  input: academyDiscussionToggleInputSchema,
  output: academyDiscussionLikeResultSchema,
  samples: [
    { verdict: 'accept', input: { postId: ID, on: false } },
    { verdict: 'refuse', input: { on: false } },
  ],
});

/** The asker marks one reply as the accepted answer; marking another moves the mark. */
export const ACADEMY_ACCEPT_DISCUSSION_REPLY = defineProcedure({
  ...base,
  name: 'academy.acceptDiscussionReply',
  kind: 'mutation',
  path: 'acceptDiscussionReply',
  access: WRITE,
  refusals: refuse({ ...POST, 'academy.permission_denied': 'FORBIDDEN' }),
  input: academyAcceptDiscussionReplyInputSchema,
  output: academyDiscussionAcceptResultSchema,
  samples: [
    { verdict: 'accept', input: { postId: ID, replyId: ID } },
    { verdict: 'refuse', input: { postId: ID } },
  ],
});

/** Report a post or reply with a reason; a repeat by the same account changes nothing (`reported: false`). */
export const ACADEMY_REPORT_DISCUSSION_POST = defineProcedure({
  ...base,
  name: 'academy.reportDiscussionPost',
  kind: 'mutation',
  path: 'reportDiscussionPost',
  access: WRITE,
  refusals: refuse({
    'academy.enrolment_required': 'FORBIDDEN',
    'academy.post_not_found': 'NOT_FOUND',
    'academy.reason_required': 'BAD_REQUEST',
  }),
  input: academyReportDiscussionPostInputSchema,
  output: academyReportDiscussionPostResultSchema,
  samples: [
    { verdict: 'accept', input: { postId: ID, reason: 'Spam' } },
    { verdict: 'refuse', input: { postId: ID, reason: '' } },
  ],
});

// ── The reader and its certificates ─────────────────────────────────────────

/** One curriculum item as the reader opens it, in the locale asked for or its fallback. */
export const academyLocalizedItemSchema = academyCurriculumSummarySchema.extend({
  body: z.string(),
  objectives: z.array(z.string()),
  keyTerms: z.array(z.object({ term: z.string(), definition: z.string() })),
  selfCheck: z.array(z.string()),
  locale: ref,
  fellBack: z.boolean(),
  i18nStrategy: z.string(),
});
export type AcademyLocalizedItem = z.infer<typeof academyLocalizedItemSchema>;

/** One certificate and the items it needs. */
export const academyCertDefinitionSchema = z.object({ id: ref, title: ref, requiredItemSlugs: z.array(ref) });
export type AcademyCertDefinition = z.infer<typeof academyCertDefinitionSchema>;

/** One certificate's progress for the signed-in learner, and how it is issued (absent from an older service). */
export const academyCertProgressSchema = z.object({
  userId: uuid,
  certId: ref,
  title: ref,
  requiredCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative(),
  ratio: z.string(),
  missingItemSlugs: z.array(ref),
  complete: z.boolean(),
  granted: z.boolean(),
  grantIdempotencyKey: ref.nullable(),
  issue: academyCertIssueSchema.optional(),
});
export type AcademyCertProgress = z.infer<typeof academyCertProgressSchema>;

/** The curriculum, optionally of one path or kind. The page size is the caller's. */
export const ACADEMY_CURRICULUM = defineProcedure({
  ...base,
  name: 'academy.curriculum',
  kind: 'query',
  path: 'curriculum',
  access: READ,
  refusals: refuse(),
  input: z
    .object({
      path: z.enum(ACADEMY_CURRICULUM_PATHS).optional(),
      kind: z.enum(ACADEMY_CURRICULUM_KINDS).optional(),
      limit: z.number().optional(),
    })
    .optional(),
  output: z.array(academyCurriculumSummarySchema),
  samples: [
    { verdict: 'accept' },
    { verdict: 'accept', input: { limit: 200, path: 'markets', kind: 'lesson' } },
    { verdict: 'refuse', input: { path: 'everything' } },
  ],
});

/** One item, read in the reader's locale; `fellBack` says when the platform's own text stands in. */
export const ACADEMY_CURRICULUM_ITEM_LOCALIZED = defineProcedure({
  ...base,
  name: 'academy.curriculumItemLocalized',
  kind: 'query',
  path: 'curriculumItemLocalized',
  access: READ,
  refusals: refuse(),
  input: z.object({ slug: z.string().min(1).max(120), locale: z.string().min(2).max(12).optional() }),
  output: academyLocalizedItemSchema,
  samples: [
    { verdict: 'accept', input: { slug: 'what-is-a-perp', locale: 'fr' } },
    { verdict: 'refuse', input: { slug: 'what-is-a-perp', locale: 'f' } },
  ],
});

/** Where this account last read, so Continue opens the same item on any device. */
export const ACADEMY_TOUCH_LESSON = defineProcedure({
  ...base,
  name: 'academy.touchLesson',
  kind: 'mutation',
  path: 'touchLesson',
  access: WRITE,
  refusals: refuse(),
  input: z.object({ slug: z.string().min(1).max(120), secondsRead: z.number().optional(), clientRequestId: z.string().min(1).max(200) }),
  output: z.object({ lastItemSlug: ref.nullable() }),
  samples: [
    { verdict: 'accept', input: { slug: 'what-is-a-perp', clientRequestId: 'open:what-is-a-perp:1' } },
    { verdict: 'refuse', input: { slug: 'what-is-a-perp' } },
  ],
});

/** Record one item complete; a course rule (a quiz pass, a watched video) may refuse it. */
export const ACADEMY_MARK_CURRICULUM_COMPLETE = defineProcedure({
  ...base,
  name: 'academy.markCurriculumComplete',
  kind: 'mutation',
  path: 'markCurriculumComplete',
  access: WRITE,
  refusals: refuse({
    'academy.completion_rule_unmet': 'PRECONDITION_FAILED',
    'academy.curriculum_not_found': 'NOT_FOUND',
    'academy.pass_mark_unset': 'PRECONDITION_FAILED',
    'academy.watch_threshold_unset': 'PRECONDITION_FAILED',
  }),
  input: z.object({ itemSlug: z.string().min(1).max(120) }),
  output: academyItemCompletionSchema,
  samples: [
    { verdict: 'accept', input: { itemSlug: 'what-is-a-perp' } },
    { verdict: 'refuse', input: { itemSlug: '' } },
  ],
});

/** Every certificate and the items it needs. Unguarded, so it names no refusal. */
export const ACADEMY_CERT_DEFINITIONS = defineProcedure({
  ...base,
  name: 'academy.certDefinitions',
  kind: 'query',
  path: 'certDefinitions',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.array(academyCertDefinitionSchema),
  samples: [{ verdict: 'accept' }],
});

/** The signed-in learner's progress toward one certificate. */
export const ACADEMY_CERT_PROGRESS = defineProcedure({
  ...base,
  name: 'academy.certProgress',
  kind: 'query',
  path: 'certProgress',
  access: READ,
  refusals: refuse({
    'academy.cert_incomplete': 'CONFLICT',
    'academy.cert_invalid': 'BAD_REQUEST',
    'academy.cert_not_due': 'CONFLICT',
    'academy.cert_not_found': 'NOT_FOUND',
    'academy.cert_revoked': 'CONFLICT',
    'academy.certificate_unpublished': 'PRECONDITION_FAILED',
  }),
  input: z.object({ certId: z.string().min(1).max(64) }),
  output: academyCertProgressSchema,
  samples: [
    { verdict: 'accept', input: { certId: 'foundations' } },
    { verdict: 'refuse', input: { certId: '' } },
  ],
});

// ── Quizzes ──────────────────────────────────────────────────────────────────

const QUIZ = {
  'academy.access_code_invalid': 'FORBIDDEN',
  'academy.assessment_invalid': 'BAD_REQUEST',
  'academy.assessment_unpublished': 'PRECONDITION_FAILED',
  'academy.assignment_not_found': 'NOT_FOUND',
  'academy.attempt_cooldown': 'TOO_MANY_REQUESTS',
  'academy.attempt_limit': 'TOO_MANY_REQUESTS',
  'academy.course_not_found': 'NOT_FOUND',
  'academy.enrolment_required': 'FORBIDDEN',
  'academy.ip_not_allowed': 'FORBIDDEN',
  'academy.ip_unreadable': 'PRECONDITION_FAILED',
  'academy.pass_mark_unset': 'PRECONDITION_FAILED',
  'academy.quiz_not_found': 'NOT_FOUND',
} as const;
const OPENING = { 'academy.not_released_yet': 'PRECONDITION_FAILED', 'academy.prerequisite_unmet': 'PRECONDITION_FAILED' } as const;
const quizSlug = z.object({ slug: z.string().min(1).max(120) }).strict();
const attemptId = z.object({ attemptId: uuid }).strict();

/** Open an attempt at a quiz; the clock runs from the server's figure. */
export const ACADEMY_ASSESSMENT_START = defineProcedure({
  ...base,
  name: 'academy.assessment.start',
  kind: 'mutation',
  path: 'assessment.start',
  access: WRITE,
  refusals: refuse({ ...QUIZ, ...OPENING }),
  input: quizSlug,
  output: academyQuizAttemptSchema,
  samples: [
    { verdict: 'accept', input: { slug: 'perps-quiz' } },
    { verdict: 'refuse', input: { slug: 'perps-quiz', extra: true } },
  ],
});

/** The open attempt at a quiz, with its deadline and the answers saved so far; null when none is open. */
export const ACADEMY_ASSESSMENT_CURRENT = defineProcedure({
  ...base,
  name: 'academy.assessment.current',
  kind: 'query',
  path: 'assessment.current',
  access: READ,
  refusals: refuse({ ...QUIZ, ...OPENING }),
  input: quizSlug,
  output: academyQuizAttemptSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { slug: 'perps-quiz' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Save one answer to an open attempt. */
export const ACADEMY_ASSESSMENT_ANSWER = defineProcedure({
  ...base,
  name: 'academy.assessment.answer',
  kind: 'mutation',
  path: 'assessment.answer',
  access: WRITE,
  refusals: refuse({ ...QUIZ, 'academy.attempt_closed': 'CONFLICT', 'academy.attempt_not_found': 'NOT_FOUND' }),
  input: z.object({ attemptId: uuid, questionId: z.string().min(1).max(80), choiceId: z.string().min(1).max(80) }).strict(),
  output: academyQuizAttemptSchema,
  samples: [
    { verdict: 'accept', input: { attemptId: ID, questionId: 'q1', choiceId: 'a' } },
    { verdict: 'refuse', input: { attemptId: ID, questionId: 'q1' } },
  ],
});

/** Finish an attempt; finishing twice scores once. */
export const ACADEMY_ASSESSMENT_FINISH = defineProcedure({
  ...base,
  name: 'academy.assessment.finish',
  kind: 'mutation',
  path: 'assessment.finish',
  access: WRITE,
  refusals: refuse({ ...QUIZ, 'academy.attempt_not_found': 'NOT_FOUND' }),
  input: attemptId,
  output: academyQuizAttemptSchema,
  samples: [
    { verdict: 'accept', input: { attemptId: ID } },
    { verdict: 'refuse', input: { attemptId: 'a1' } },
  ],
});

/** A finished attempt's review, once its results are visible. */
export const ACADEMY_ASSESSMENT_REVIEW = defineProcedure({
  ...base,
  name: 'academy.assessment.review',
  kind: 'query',
  path: 'assessment.review',
  access: READ,
  refusals: refuse({
    'academy.attempt_not_found': 'NOT_FOUND',
    'academy.attempt_open': 'CONFLICT',
    'academy.course_not_found': 'NOT_FOUND',
    'academy.grades_hidden': 'PRECONDITION_FAILED',
  }),
  input: attemptId,
  output: academyQuizReviewSchema,
  samples: [
    { verdict: 'accept', input: { attemptId: ID } },
    { verdict: 'refuse', input: { attemptId: ID, slug: 'perps-quiz' } },
  ],
});

// ── Progress and the planner ─────────────────────────────────────────────────

const TODO = { 'academy.todo_not_found': 'NOT_FOUND' } as const;
const GOAL = { 'academy.goal_invalid': 'BAD_REQUEST' } as const;

/** Percent complete per enrolled course and the grades, from one read of the learner's own rows. */
export const ACADEMY_MY_PROGRESS = defineProcedure({
  ...base,
  name: 'academy.myProgress',
  kind: 'query',
  path: 'myProgress',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: academyProgressPageSchema,
  accept: {
    progressAddsUp: {
      says: 'every course row has no more completed than visible items, and one item per visible item',
      holds: (page) => (page as AcademyProgressPage).courses.every(academyCourseProgressAddsUp),
    },
  },
  samples: [{ verdict: 'accept' }],
});

/** The learner's planner: to-do items, the weekly goal and the reminder's mail dependency. */
export const ACADEMY_PLANNER_GET = defineProcedure({
  ...base,
  name: 'academy.planner.get',
  kind: 'query',
  path: 'planner.get',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: academyPlannerSchema,
  samples: [{ verdict: 'accept' }],
});

/** Add a to-do item; the client key makes a lost reply sent again return the stored item. */
export const ACADEMY_PLANNER_ADD_TODO = defineProcedure({
  ...base,
  name: 'academy.planner.addTodo',
  kind: 'mutation',
  path: 'planner.addTodo',
  access: WRITE,
  refusals: refuse({
    'academy.planner_full': 'CONFLICT',
    'academy.planner_limit_unset': 'PRECONDITION_FAILED',
    'academy.request_reused': 'CONFLICT',
  }),
  input: academyAddTodoInputSchema,
  output: academyPlannerTodoSchema,
  samples: [
    { verdict: 'accept', input: { clientKey: 'todo:3:abc', text: 'Read the funding lesson' } },
    { verdict: 'refuse', input: { clientKey: 'todo:3:abc', text: '' } },
  ],
});

/** Tick a to-do item done or not done. */
export const ACADEMY_PLANNER_SET_TODO_DONE = defineProcedure({
  ...base,
  name: 'academy.planner.setTodoDone',
  kind: 'mutation',
  path: 'planner.setTodoDone',
  access: WRITE,
  refusals: refuse(TODO),
  input: academySetTodoDoneInputSchema,
  output: academyPlannerTodoSchema,
  samples: [
    { verdict: 'accept', input: { todoId: ID, done: true } },
    { verdict: 'refuse', input: { todoId: ID } },
  ],
});

/** Remove a to-do item; removing it again answers the same. */
export const ACADEMY_PLANNER_REMOVE_TODO = defineProcedure({
  ...base,
  name: 'academy.planner.removeTodo',
  kind: 'mutation',
  path: 'planner.removeTodo',
  access: WRITE,
  refusals: refuse(TODO),
  input: academyRemoveTodoInputSchema,
  output: z.object({ id: z.string(), removed: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { todoId: ID } },
    { verdict: 'refuse', input: { todoId: 'todo-1' } },
  ],
});

/** Set the weekly goal; the bounds are svc-academy's (`academy.goal_invalid`). */
export const ACADEMY_PLANNER_SET_GOAL = defineProcedure({
  ...base,
  name: 'academy.planner.setGoal',
  kind: 'mutation',
  path: 'planner.setGoal',
  access: WRITE,
  refusals: refuse(GOAL),
  input: academySetGoalInputSchema,
  output: academyGoalSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { itemsPerWeek: 3, reminder: true } },
    { verdict: 'refuse', input: { itemsPerWeek: 2.5, reminder: true } },
  ],
});

/** Send the goal reminder now: it answers that no mail is sent while Academy has no mail sender. */
export const ACADEMY_PLANNER_SEND_GOAL_REMINDER = defineProcedure({
  ...base,
  name: 'academy.planner.sendGoalReminder',
  kind: 'mutation',
  path: 'planner.sendGoalReminder',
  access: WRITE,
  refusals: refuse(GOAL),
  input: NO_INPUT,
  output: academyGoalReminderSchema,
  samples: [{ verdict: 'accept' }],
});

/** Every learner record in this file. */
export const ACADEMY_LEARNER_PROCEDURES = [
  ACADEMY_ROOMS,
  ACADEMY_SESSION,
  ACADEMY_JOIN,
  ACADEMY_LEAVE,
  ACADEMY_CREATE_ROOM,
  ACADEMY_DISCUSSION_COURSES,
  ACADEMY_DISCUSSION_TOPICS,
  ACADEMY_DISCUSSION_POSTS,
  ACADEMY_DISCUSSION_THREAD,
  ACADEMY_DISCUSSION_POST_IMAGE,
  ACADEMY_CREATE_DISCUSSION_POST,
  ACADEMY_REPLY_DISCUSSION_POST,
  ACADEMY_FOLLOW_DISCUSSION_POST,
  ACADEMY_LIKE_DISCUSSION_POST,
  ACADEMY_ACCEPT_DISCUSSION_REPLY,
  ACADEMY_REPORT_DISCUSSION_POST,
  ACADEMY_CURRICULUM,
  ACADEMY_CURRICULUM_ITEM_LOCALIZED,
  ACADEMY_TOUCH_LESSON,
  ACADEMY_MARK_CURRICULUM_COMPLETE,
  ACADEMY_CERT_DEFINITIONS,
  ACADEMY_CERT_PROGRESS,
  ACADEMY_ASSESSMENT_START,
  ACADEMY_ASSESSMENT_CURRENT,
  ACADEMY_ASSESSMENT_ANSWER,
  ACADEMY_ASSESSMENT_FINISH,
  ACADEMY_ASSESSMENT_REVIEW,
  ACADEMY_MY_PROGRESS,
  ACADEMY_PLANNER_GET,
  ACADEMY_PLANNER_ADD_TODO,
  ACADEMY_PLANNER_SET_TODO_DONE,
  ACADEMY_PLANNER_REMOVE_TODO,
  ACADEMY_PLANNER_SET_GOAL,
  ACADEMY_PLANNER_SEND_GOAL_REMINDER,
] as const;
