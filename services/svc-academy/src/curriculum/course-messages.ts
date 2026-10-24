/**
 * AC-rooms-04 — message the course team: a learner enrolled in a course staff made writes to its team, and staff answer
 * from their inbox. One conversation per course and learner; each side's unread marker is on while the other side wrote
 * after it last read, and opening the conversation clears it. A learner reads only their own conversations; the account
 * always comes from the signed principal. Mail copies need an email provider, which this build has none of, so every
 * answer names `vendor.email` for the copy and the message is stored either way. Message length is an owner value with no
 * default (`ACADEMY_MESSAGE_MAX_CHARS`): a send while it is blank refuses `academy.message_limit_unset`. A retry with the
 * same client request id from the same side is the same message; a different message under it refuses
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
  unread: boolean;
};
type MessageRow = { id: string; sender: Sender; sender_id: string; body: string; sent_at: Date; conversation_id: string };

/** The mail copy of every message: there is no email provider in this build. */
const MAIL_COPY = { state: 'not_connected', code: 'vendor.email' } as const;

/** Each side keeps its own request ids: the stored key names the side, so a staff account that also learns never collides. */
const requestKey = (sender: Sender, clientRequestId: string) => `${sender}:${clientRequestId}`;

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

  /** Conversations with the reader's unread marker: on while the other side wrote after the reader last read. */
  private conversations(reader: Sender, where: { id?: string; learnerId?: string }, limit: number) {
    const db = this.sql;
    const other = reader === 'learner' ? 'staff' : 'learner';
    const readAt = reader === 'learner' ? db`v.learner_read_at` : db`v.staff_read_at`;
    return db<ConversationRow[]>`
      SELECT v.id, v.course_id, c.slug AS course_slug, c.title AS course_title, v.learner_id, v.last_message_at,
             EXISTS (SELECT 1 FROM academy.course_messages m WHERE m.conversation_id = v.id AND m.sender = ${other}
                      AND (${readAt} IS NULL OR m.sent_at > ${readAt})) AS unread
        FROM academy.course_conversations v JOIN academy.courses c ON c.id = v.course_id
       WHERE ${where.id === undefined ? db`TRUE` : db`v.id = ${where.id}`}
         AND ${where.learnerId === undefined ? db`TRUE` : db`v.learner_id = ${where.learnerId}`}
       ORDER BY v.last_message_at DESC, v.id
       LIMIT ${limit}
    `;
  }

  /** The newest `limit` messages, oldest first, and whether older ones were left out. */
  private async messages(conversationId: string, limit: number) {
    const rows = await this.sql<MessageRow[]>`
      SELECT id, conversation_id, sender, sender_id, body, sent_at FROM academy.course_messages
       WHERE conversation_id = ${conversationId} ORDER BY sent_at DESC, id DESC LIMIT ${limit + 1}
    `;
    return { earlier: rows.length > limit, rows: rows.slice(0, limit).reverse() };
  }

  /**
   * The stored message under this side's request id, refusing one that answers a different message. A conversation is
   * matched by id, or for a learner's first send by its course, since the conversation may not exist before it.
   */
  private async byRequest(
    sender: Sender,
    senderId: string,
    clientRequestId: string,
    same: { conversationId?: string; courseSlug?: string; body: string },
  ) {
    const [row] = await this.sql<(MessageRow & { course_slug: string })[]>`
      SELECT m.id, m.conversation_id, m.sender, m.sender_id, m.body, m.sent_at, c.slug AS course_slug
        FROM academy.course_messages m
        JOIN academy.course_conversations v ON v.id = m.conversation_id
        JOIN academy.courses c ON c.id = v.course_id
       WHERE m.sender_id = ${senderId} AND m.client_request_id = ${requestKey(sender, clientRequestId)}
    `;
    if (!row) return null;
    const sameConversation =
      same.conversationId !== undefined ? row.conversation_id === same.conversationId : row.course_slug === same.courseSlug;
    if (!sameConversation || row.body !== same.body)
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
    const stored = await this.byRequest(input.sender, input.senderId, input.clientRequestId, same);
    if (stored) return stored;
    await transaction(this.sql, async (tx) => {
      const [inserted] = await tx<{ id: string }[]>`
        INSERT INTO academy.course_messages (conversation_id, sender, sender_id, body, client_request_id, sent_at)
        VALUES (${input.conversationId}, ${input.sender}, ${input.senderId}, ${input.body},
                ${requestKey(input.sender, input.clientRequestId)}, ${input.now})
        ON CONFLICT (sender_id, client_request_id) DO NOTHING
        RETURNING id
      `;
      // Sending never marks the other side's messages read: only opening the conversation does.
      if (inserted)
        await tx`
          UPDATE academy.course_conversations SET last_message_at = GREATEST(last_message_at, ${input.now})
           WHERE id = ${input.conversationId}
        `;
    });
    return (await this.byRequest(input.sender, input.senderId, input.clientRequestId, same))!;
  }

  /** The learner writes to the course team of a published course they are enrolled in. */
  async send(input: AcademySendCourseMessageInput & { userId: string; now: Date }): Promise<AcademySendCourseMessageResult> {
    // A retry of a message already stored answers with it, even if the course or the limit changed since.
    const stored = await this.byRequest('learner', input.userId, input.clientRequestId, {
      courseSlug: input.courseSlug,
      body: input.body,
    });
    if (stored) return { conversationId: stored.conversation_id, message: messageOf(stored), mailCopy: MAIL_COPY };
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
    return (await this.conversations('learner', { learnerId: userId }, limit)).map((row) => ({
      id: row.id,
      courseSlug: row.course_slug,
      courseTitle: row.course_title,
      lastMessageAt: row.last_message_at,
      unread: row.unread,
    }));
  }

  /** One of the learner's own conversations; opening it marks it read on their side. Anyone else's is not found. */
  async open(input: { userId: string; conversationId: string; limit: number; now: Date }): Promise<AcademyCourseConversation> {
    const [row] = await this.conversations('learner', { id: input.conversationId, learnerId: input.userId }, 1);
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
      earlier: messages.earlier,
      messages: messages.rows.map(messageOf),
    };
  }

  /** Staff: every conversation, newest first. */
  async staffInbox(limit: number): Promise<AcademyStaffConversationSummary[]> {
    return (await this.conversations('staff', {}, limit)).map((row) => ({
      id: row.id,
      courseId: row.course_id,
      courseSlug: row.course_slug,
      courseTitle: row.course_title,
      learnerId: row.learner_id,
      lastMessageAt: row.last_message_at,
      staffUnread: row.unread,
    }));
  }

  /** Staff: one conversation with the account behind each message; opening it marks it read on the staff side. */
  async staffOpen(input: { conversationId: string; limit: number; now: Date }): Promise<AcademyStaffConversation> {
    const [row] = await this.conversations('staff', { id: input.conversationId }, 1);
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
      earlier: messages.earlier,
      messages: messages.rows.map((m) => ({ ...messageOf(m), senderId: m.sender_id })),
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
