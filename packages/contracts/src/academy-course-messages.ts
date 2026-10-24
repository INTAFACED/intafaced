import { z } from 'zod';
import { academyCourseSlugSchema } from './academy-courses.js';

/**
 * AC-rooms-04: a learner writes to the course team of a course staff made, and staff answer from their inbox. There is one
 * conversation per course and learner, with an unread marker on each side: a side's marker is on while the other side
 * wrote after it last read. A learner reads only their own conversations. Mail copies of messages need an email provider,
 * which this build has none of: every message is stored and its answer names `vendor.email` for the copy. Message length
 * is an owner value with no default: a send while it is blank refuses `academy.message_limit_unset`. No money moves here.
 */
export const ACADEMY_COURSE_MESSAGE_SENDERS = ['learner', 'staff'] as const;
/** The most rows one messages read lists. */
export const ACADEMY_COURSE_MESSAGES_LIST_MAX = 200;

const requestId = z.string().trim().min(1).max(200);
const body = z.string().trim().min(1).max(20_000);

export const academyCourseMessageSchema = z.object({
  id: z.string().guid(),
  from: z.enum(ACADEMY_COURSE_MESSAGE_SENDERS),
  body: z.string(),
  sentAt: z.coerce.date(),
});
export type AcademyCourseMessage = z.infer<typeof academyCourseMessageSchema>;

/** One conversation in the learner's inbox. `unread` is on while staff wrote after the learner last opened it. */
export const academyCourseConversationSummarySchema = z.object({
  id: z.string().guid(),
  courseSlug: z.string(),
  courseTitle: z.string(),
  lastMessageAt: z.coerce.date(),
  unread: z.boolean(),
});
export type AcademyCourseConversationSummary = z.infer<typeof academyCourseConversationSummarySchema>;

/** One conversation with its newest messages, oldest first; `earlier` is on when older ones were left out. */
export const academyCourseConversationSchema = academyCourseConversationSummarySchema.extend({
  earlier: z.boolean(),
  messages: z.array(academyCourseMessageSchema),
});
export type AcademyCourseConversation = z.infer<typeof academyCourseConversationSchema>;

/**
 * Where the mail copy of a message stands. This build has no email provider, so it is `not_connected` with the allowlist
 * code; the message itself is stored either way.
 */
export const academyMailCopySchema = z.object({ state: z.literal('not_connected'), code: z.literal('vendor.email') });

/** `sendCourseMessage`: the learner writes to the course team. A retry with the same client request id is the same message. */
export const academySendCourseMessageInputSchema = z
  .object({ courseSlug: academyCourseSlugSchema, body, clientRequestId: requestId })
  .strict();
export type AcademySendCourseMessageInput = z.infer<typeof academySendCourseMessageInputSchema>;

export const academySendCourseMessageResultSchema = z.object({
  conversationId: z.string().guid(),
  message: academyCourseMessageSchema,
  mailCopy: academyMailCopySchema,
});
export type AcademySendCourseMessageResult = z.infer<typeof academySendCourseMessageResultSchema>;

export const academyCourseConversationsInputSchema = z
  .object({ limit: z.number().int().min(1).max(ACADEMY_COURSE_MESSAGES_LIST_MAX) })
  .strict();
/** `courseConversation`: opening it marks it read on the reader's side. */
export const academyCourseConversationInputSchema = z
  .object({ conversationId: z.string().guid(), limit: z.number().int().min(1).max(ACADEMY_COURSE_MESSAGES_LIST_MAX) })
  .strict();

/** `admin.courseInbox`: every conversation, newest first. `staffUnread` is on while the learner wrote after staff last read. */
export const academyStaffConversationSummarySchema = z.object({
  id: z.string().guid(),
  courseId: z.string().guid(),
  courseSlug: z.string(),
  courseTitle: z.string(),
  learnerId: z.string().guid(),
  lastMessageAt: z.coerce.date(),
  staffUnread: z.boolean(),
});
export type AcademyStaffConversationSummary = z.infer<typeof academyStaffConversationSummarySchema>;

export const academyStaffConversationSchema = academyStaffConversationSummarySchema.extend({
  earlier: z.boolean(),
  messages: z.array(academyCourseMessageSchema.extend({ senderId: z.string().guid() })),
});
export type AcademyStaffConversation = z.infer<typeof academyStaffConversationSchema>;

/** `admin.replyCourseMessage`: staff answer a conversation. A retry with the same client request id is the same reply. */
export const academyReplyCourseMessageInputSchema = z
  .object({ conversationId: z.string().guid(), body, clientRequestId: requestId })
  .strict();
export type AcademyReplyCourseMessageInput = z.infer<typeof academyReplyCourseMessageInputSchema>;
