/**
 * AC-rooms-04 — message the course team: a learner enrolled in a course staff made writes to its team, and staff answer
 * from their inbox. One conversation per course and learner; each side's unread marker is on while the other side wrote
 * after it last read, and opening the conversation clears it. A learner reads only their own conversations; the account
 * always comes from the signed principal. Mail copies need an email provider, which this build has none of, so every
 * answer names `vendor.email` for the copy and the message is stored either way. Message length is an owner value with no
 * default (`ACADEMY_MESSAGE_MAX_CHARS`): a send while it is blank refuses `academy.message_limit_unset`. A retry with the
 * same client request id is the same message (`msg:<account>:<request>`); a different message under it refuses
 * `academy.request_reused`. No money moves here.
 */
import type { Sql } from 'postgres';
import type {
  AcademyCourseConversation,
  AcademyCourseConversationSummary,
  AcademyCourseMessage,
  AcademyReplyCourseMessageInput,
  AcademySendCourseMessageInput,
  AcademySendCourseMessageResult,
  AcademyStaffConversation,
  AcademyStaffConversationSummary,
} from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import { AcademyError } from '../errors.js';

type Sender = 'learner' | 'staff';
type ConversationRow = {
  id: string;
  course_id: string;
  course_slug: string;
  course_title: string;
  learner_id: string;
  last_message_at: Date;
  learner_unread: boolean;
  staff_unread: boolean;
};
type MessageRow = { id: string; sender: Sender; sender_id: string; body: string; sent_at: Date; conversation_id: string };

/** The mail copy of every message: there is no email provider in this build. */
const MAIL_COPY = { state: 'not_connected', code: 'vendor.email' } as const;

const messageOf = (row: MessageRow): AcademyCourseMessage => ({ id: row.id, from: row.sender, body: row.body, sentAt: row.sent_at });

/** Pure: refuses a message while the owner's length is blank, or over it. */
export function checkMessageLength(body: string, maxChars: number | null): void {
  if (maxChars === null) throw new AcademyError('academy.message_limit_unset', 'academy.message_limit_unset');
  const chars = [...body].length;
  if (chars > maxChars) throw new AcademyError(`academy.message_too_long chars=${chars} max=${maxChars}`, 'academy.message_too_long');
}

export class CourseMessages {
  constructor(
    private readonly sql: Sql,
    private readonly maxChars: number | null,
  ) {}

  private conversations(where: { id?: string; learnerId?: string }, limit: number) {
    const db = this.sql;
    return db<ConversationRow[]>`
      SELECT v.id, v.course_id, c.slug AS course_slug, c.title AS course_title, v.learner_id, v.last_message_at,
             EXISTS (SELECT 1 FROM academy.course_messages m WHERE m.conversation_id = v.id AND m.sender = 'staff'
                      AND (v.learner_read_at IS NULL OR m.sent_at > v.learner_read_at)) AS learner_unread,
             EXISTS (SELECT 1 FROM academy.course_messages m WHERE m.conversation_id = v.id AND m.sender = 'learner'
                      AND (v.staff_read_at IS NULL OR m.sent_at > v.staff_read_at)) AS staff_unread
        FROM academy.course_conversations v JOIN academy.courses c ON c.id = v.course_id
       WHERE ${where.id === undefined ? db`TRUE` : db`v.id = ${where.id}`}
         AND ${where.learnerId === undefined ? db`TRUE` : db`v.learner_id = ${where.learnerId}`}
       ORDER BY v.last_message_at DESC, v.id
       LIMIT ${limit}
    `;
  }

  private messages(conversationId: string, limit: number) {
    // The newest `limit` messages, shown oldest first.
    return this.sql<MessageRow[]>`
      SELECT * FROM (
        SELECT id, conversation_id, sender, sender_id, body, sent_at FROM academy.course_messages
         WHERE conversation_id = ${conversationId} ORDER BY sent_at DESC, id DESC LIMIT ${limit}
      ) recent ORDER BY sent_at, id
    `;
  }

  /** The stored message under this sender's request id, refusing one that answers a different message. */
  private async byRequest(senderId: string, clientRequestId: string, same: { conversationId: string; body: string }) {
    const [row] = await this.sql<MessageRow[]>`
      SELECT id, conversation_id, sender, sender_id, body, sent_at FROM academy.course_messages
       WHERE sender_id = ${senderId} AND client_request_id = ${clientRequestId}
    `;
    if (!row) return null;
    if (row.conversation_id !== same.conversationId || row.body !== same.body)
      throw new AcademyError(`academy.request_reused request=${clientRequestId} answers another message`, 'academy.request_reused');
    return row;
  }

  private async insert(input: {
    conversationId: string;
    sender: Sender;
    senderId: string;
    body: string;
    clientRequestId: string;
    now: Date;
  }) {
    const same = { conversationId: input.conversationId, body: input.body };
    const stored = await this.byRequest(input.senderId, input.clientRequestId, same);
    if (stored) return stored;
    await transaction(this.sql, async (tx) => {
      const [inserted] = await tx<{ id: string }[]>`
        INSERT INTO academy.course_messages (conversation_id, sender, sender_id, body, client_request_id, sent_at)
        VALUES (${input.conversationId}, ${input.sender}, ${input.senderId}, ${input.body}, ${input.clientRequestId}, ${input.now})
        ON CONFLICT (sender_id, client_request_id) DO NOTHING
        RETURNING id
      `;
      if (inserted)
        await tx`
          UPDATE academy.course_conversations SET last_message_at = GREATEST(last_message_at, ${input.now}),
            ${input.sender === 'learner' ? tx`learner_read_at` : tx`staff_read_at`} = ${input.now}
           WHERE id = ${input.conversationId}
        `;
    });
    return (await this.byRequest(input.senderId, input.clientRequestId, same))!;
  }

  /** The learner writes to the course team of a published course they are enrolled in. */
  async send(input: AcademySendCourseMessageInput & { userId: string; now: Date }): Promise<AcademySendCourseMessageResult> {
    const [course] = await this.sql<{ id: string; enrolled: boolean }[]>`
      SELECT c.id, EXISTS (SELECT 1 FROM academy.course_enrolments e
               WHERE e.course_id = c.id AND e.user_id = ${input.userId} AND e.left_at IS NULL) AS enrolled
        FROM academy.courses c WHERE c.slug = ${input.courseSlug} AND c.state = 'published'
    `;
    if (!course) throw new AcademyError(`academy.course_not_found slug=${input.courseSlug}`, 'academy.course_not_found');
    if (!course.enrolled)
      throw new AcademyError('academy.enrolment_required enrol in this course to message its course team', 'academy.enrolment_required');
    checkMessageLength(input.body, this.maxChars);
    await this.sql`
      INSERT INTO academy.course_conversations (course_id, learner_id, created_at, last_message_at)
      VALUES (${course.id}, ${input.userId}, ${input.now}, ${input.now})
      ON CONFLICT (course_id, learner_id) DO NOTHING
    `;
    const [conversation] = await this.sql<{ id: string }[]>`
      SELECT id FROM academy.course_conversations WHERE course_id = ${course.id} AND learner_id = ${input.userId}
    `;
    const row = await this.insert({
      conversationId: conversation!.id,
      sender: 'learner',
      senderId: input.userId,
      body: input.body,
      clientRequestId: input.clientRequestId,
      now: input.now,
    });
    return { conversationId: conversation!.id, message: messageOf(row), mailCopy: MAIL_COPY };
  }

  /** The learner's own conversations, newest first. */
  async inbox(userId: string, limit: number): Promise<AcademyCourseConversationSummary[]> {
    return (await this.conversations({ learnerId: userId }, limit)).map((row) => ({
      id: row.id,
      courseSlug: row.course_slug,
      courseTitle: row.course_title,
      lastMessageAt: row.last_message_at,
      unread: row.learner_unread,
    }));
  }

  /** One of the learner's own conversations; opening it marks it read on their side. Anyone else's is not found. */
  async open(input: { userId: string; conversationId: string; limit: number; now: Date }): Promise<AcademyCourseConversation> {
    const [row] = await this.conversations({ id: input.conversationId, learnerId: input.userId }, 1);
    if (!row) throw new AcademyError(`academy.conversation_not_found id=${input.conversationId}`, 'academy.conversation_not_found');
    await this.sql`
      UPDATE academy.course_conversations SET learner_read_at = GREATEST(COALESCE(learner_read_at, ${input.now}), ${input.now})
       WHERE id = ${row.id}
    `;
    const messages = await this.messages(row.id, input.limit);
    return {
      id: row.id,
      courseSlug: row.course_slug,
      courseTitle: row.course_title,
      lastMessageAt: row.last_message_at,
      unread: false,
      messages: messages.map(messageOf),
    };
  }

  /** Staff: every conversation, newest first. */
  async staffInbox(limit: number): Promise<AcademyStaffConversationSummary[]> {
    return (await this.conversations({}, limit)).map((row) => ({
      id: row.id,
      courseId: row.course_id,
      courseSlug: row.course_slug,
      courseTitle: row.course_title,
      learnerId: row.learner_id,
      lastMessageAt: row.last_message_at,
      staffUnread: row.staff_unread,
    }));
  }

  /** Staff: one conversation with the account behind each message; opening it marks it read on the staff side. */
  async staffOpen(input: { conversationId: string; limit: number; now: Date }): Promise<AcademyStaffConversation> {
    const [row] = await this.conversations({ id: input.conversationId }, 1);
    if (!row) throw new AcademyError(`academy.conversation_not_found id=${input.conversationId}`, 'academy.conversation_not_found');
    await this.sql`
      UPDATE academy.course_conversations SET staff_read_at = GREATEST(COALESCE(staff_read_at, ${input.now}), ${input.now})
       WHERE id = ${row.id}
    `;
    const messages = await this.messages(row.id, input.limit);
    return {
      id: row.id,
      courseId: row.course_id,
      courseSlug: row.course_slug,
      courseTitle: row.course_title,
      learnerId: row.learner_id,
      lastMessageAt: row.last_message_at,
      staffUnread: false,
      messages: messages.map((m) => ({ ...messageOf(m), senderId: m.sender_id })),
    };
  }

  /** Staff answer a conversation. The learner's marker turns on until they open it. */
  async staffReply(
    input: AcademyReplyCourseMessageInput & { operatorId: string; now: Date },
  ): Promise<{ conversationId: string; message: AcademyCourseMessage; mailCopy: typeof MAIL_COPY }> {
    const [row] = await this.sql<{ id: string }[]>`SELECT id FROM academy.course_conversations WHERE id = ${input.conversationId}`;
    if (!row) throw new AcademyError(`academy.conversation_not_found id=${input.conversationId}`, 'academy.conversation_not_found');
    checkMessageLength(input.body, this.maxChars);
    const message = await this.insert({
      conversationId: row.id,
      sender: 'staff',
      senderId: input.operatorId,
      body: input.body,
      clientRequestId: input.clientRequestId,
      now: input.now,
    });
    return { conversationId: row.id, message: messageOf(message), mailCopy: MAIL_COPY };
  }
}
