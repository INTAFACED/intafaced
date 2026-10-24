import { z } from 'zod';
import { ACADEMY_COURSE_SLUG, academyCourseSlugSchema } from './academy-courses.js';

/**
 * AC-rooms-01: the discussion of a course staff made. Every course has a default General topic; staff add course-wide
 * topics, pin them and set their order, and pinned topics always come first. A learner enrolled in the course posts a
 * question or a discussion, may post anonymously to classmates (staff still see the account), and may attach one image.
 * Replies nest one level. The asker marks one reply as the accepted answer; follow and like are set once. Post length and
 * image size are owner values with no default: a post while either is blank refuses by name. No money moves here.
 */
export const ACADEMY_DISCUSSION_GENERAL_TOPIC = 'general';
export const ACADEMY_DISCUSSION_POST_KINDS = ['question', 'discussion'] as const;
export type AcademyDiscussionPostKind = (typeof ACADEMY_DISCUSSION_POST_KINDS)[number];
/** The image types a post may carry, checked by their leading bytes. An SVG is never one (it can carry script). */
export const ACADEMY_DISCUSSION_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif'] as const;
/** The most rows one discussion read lists. */
export const ACADEMY_DISCUSSION_LIST_MAX = 200;

export const academyDiscussionTopicSlugSchema = z.string().min(3).max(48).regex(ACADEMY_COURSE_SLUG);
const requestId = z.string().trim().min(1).max(200);
const body = z.string().trim().min(1).max(20_000);

/** `admin.saveDiscussionTopic`: create a course-wide topic, or change its title, pin and position. General is not saved here. */
export const academySaveDiscussionTopicInputSchema = z
  .object({
    courseId: z.string().guid(),
    slug: academyDiscussionTopicSlugSchema.refine((s) => s !== ACADEMY_DISCUSSION_GENERAL_TOPIC, {
      message: 'General is every course’s default topic and is not saved',
    }),
    title: z.string().trim().min(1).max(120),
    pinned: z.boolean(),
    position: z.number().int().min(0).max(10_000),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademySaveDiscussionTopicInput = z.infer<typeof academySaveDiscussionTopicInputSchema>;

export const academyDiscussionTopicSchema = z.object({
  slug: z.string(),
  title: z.string(),
  pinned: z.boolean(),
  position: z.number().int().nonnegative(),
  /** True for the course's default General topic. */
  general: z.boolean(),
  posts: z.number().int().nonnegative(),
});
export type AcademyDiscussionTopic = z.infer<typeof academyDiscussionTopicSchema>;

/** A course the caller can open the discussion of: one they are enrolled in that is published. */
export const academyDiscussionCourseSchema = z.object({ courseId: z.string().guid(), slug: z.string(), title: z.string() });
export type AcademyDiscussionCourse = z.infer<typeof academyDiscussionCourseSchema>;

/** `discussionTopics`: the course and its topics in order, pinned first. */
export const academyDiscussionTopicsSchema = z.object({
  course: academyDiscussionCourseSchema,
  topics: z.array(academyDiscussionTopicSchema),
});
export type AcademyDiscussionTopics = z.infer<typeof academyDiscussionTopicsSchema>;

/**
 * Who wrote a post, as a classmate sees it: the caller themself, a classmate under a name stable within this course, or
 * anonymous. A classmate's account id is never sent to a learner.
 */
export const academyDiscussionAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('you'), anonymous: z.boolean() }),
  z.object({ kind: z.literal('learner'), label: z.string() }),
  z.object({ kind: z.literal('anonymous') }),
]);
export type AcademyDiscussionAuthor = z.infer<typeof academyDiscussionAuthorSchema>;

export const academyDiscussionImageSchema = z.object({ contentType: z.enum(ACADEMY_DISCUSSION_IMAGE_TYPES), base64: z.string() });

export const academyDiscussionPostSchema = z.object({
  id: z.string().guid(),
  topicSlug: z.string(),
  kind: z.enum(ACADEMY_DISCUSSION_POST_KINDS),
  title: z.string(),
  body: z.string(),
  author: academyDiscussionAuthorSchema,
  createdAt: z.coerce.date(),
  replies: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  liked: z.boolean(),
  following: z.boolean(),
  /** The reply the asker accepted, on a question; null when none is. */
  acceptedReplyId: z.string().guid().nullable(),
  hasImage: z.boolean(),
});
export type AcademyDiscussionPost = z.infer<typeof academyDiscussionPostSchema>;

export const academyDiscussionReplySchema = z.object({
  id: z.string().guid(),
  body: z.string(),
  author: academyDiscussionAuthorSchema,
  createdAt: z.coerce.date(),
  likes: z.number().int().nonnegative(),
  liked: z.boolean(),
  accepted: z.boolean(),
});
export type AcademyDiscussionReply = z.infer<typeof academyDiscussionReplySchema>;

/** `discussionThread`: one post with its image and its replies, the accepted answer first, then oldest first. */
export const academyDiscussionThreadSchema = z.object({
  course: academyDiscussionCourseSchema,
  post: academyDiscussionPostSchema,
  image: academyDiscussionImageSchema.nullable(),
  replies: z.array(academyDiscussionReplySchema),
  /** True when the caller asked the question, and so may mark the accepted answer. */
  canAccept: z.boolean(),
});
export type AcademyDiscussionThread = z.infer<typeof academyDiscussionThreadSchema>;

export const academyDiscussionCoursesInputSchema = z.object({ limit: z.number().int().min(1).max(ACADEMY_DISCUSSION_LIST_MAX) }).strict();
export const academyDiscussionTopicsInputSchema = z.object({ courseSlug: academyCourseSlugSchema }).strict();
export const academyDiscussionPostsInputSchema = z
  .object({
    courseSlug: academyCourseSlugSchema,
    topicSlug: academyDiscussionTopicSlugSchema,
    limit: z.number().int().min(1).max(ACADEMY_DISCUSSION_LIST_MAX),
  })
  .strict();
export const academyDiscussionThreadInputSchema = z.object({ postId: z.string().guid() }).strict();

/**
 * `createDiscussionPost`. The client request id makes a retry the same post (`post:<account>:<request>`). The image's
 * declared type is checked against its leading bytes; anything that is not one of the image types refuses
 * `academy.attachment_type_refused`.
 */
export const academyCreateDiscussionPostInputSchema = z
  .object({
    courseSlug: academyCourseSlugSchema,
    topicSlug: academyDiscussionTopicSlugSchema,
    kind: z.enum(ACADEMY_DISCUSSION_POST_KINDS),
    title: z.string().trim().min(1).max(200),
    body,
    anonymous: z.boolean(),
    image: z.object({ contentType: z.string().min(1).max(200), base64: z.string().min(1).max(2_000_000) }).strict().nullable(),
    clientRequestId: requestId,
  })
  .strict();
export type AcademyCreateDiscussionPostInput = z.infer<typeof academyCreateDiscussionPostInputSchema>;

/** `replyDiscussionPost`: a reply to a post; replies nest one level, so a reply takes no reply. */
export const academyReplyDiscussionPostInputSchema = z
  .object({ postId: z.string().guid(), body, anonymous: z.boolean(), clientRequestId: requestId })
  .strict();
export type AcademyReplyDiscussionPostInput = z.infer<typeof academyReplyDiscussionPostInputSchema>;

/** `acceptDiscussionReply`: the asker marks one reply as the accepted answer; marking another moves the mark. */
export const academyAcceptDiscussionReplyInputSchema = z.object({ postId: z.string().guid(), replyId: z.string().guid() }).strict();

/** `followDiscussionPost` and `likeDiscussionPost`: set on or off; a repeat changes nothing. Like takes a post or a reply. */
export const academyDiscussionToggleInputSchema = z.object({ postId: z.string().guid(), on: z.boolean() }).strict();

/** `admin.discussionThread`: a post and its replies as staff see them, with the account behind each, anonymous or not. */
const staffEntry = z.object({
  id: z.string().guid(),
  authorId: z.string().guid(),
  anonymous: z.boolean(),
  body: z.string(),
  createdAt: z.coerce.date(),
});
export const academyStaffDiscussionThreadSchema = z.object({
  post: staffEntry.extend({ courseId: z.string().guid(), topicSlug: z.string(), kind: z.enum(ACADEMY_DISCUSSION_POST_KINDS), title: z.string() }),
  replies: z.array(staffEntry),
});
export type AcademyStaffDiscussionThread = z.infer<typeof academyStaffDiscussionThreadSchema>;
