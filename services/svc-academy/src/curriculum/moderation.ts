/**
 * AC-rooms-02 (J-academy-18): reports, the moderation queue, and deleting posts with a reason.
 *
 * A learner enrolled in the course reports a post or reply with a reason; one report per account per post, so a repeat
 * changes nothing (`report:<post>:<account>`). The queue lists the reported entries still showing, oldest report first,
 * with the number of reports and their reasons; who reported is never shown to the author. A moderator (a session with
 * `admin:write` whose roles on the course permit `discussion.moderate`) deletes an entry with a reason: a state move, never
 * a row delete, and a deleted post takes its replies out of every learner read with it. Bulk delete takes every entry of
 * one author in one course and none elsewhere. Each action is an append-only event naming the actor and the reason, keyed
 * on the business (`moderate:<post>:delete`, `moderate:<course>:<author>:bulk:<n>`), and its author is told in their
 * notification tray: the event row waits in the outbox until the bus took the notice, and every later action and every
 * boot sends what is still waiting. No money moves.
 */
import type { Sql } from 'postgres';
import type { AcademyModerationEvent, AcademyModerationQueue, AcademyModerationReport } from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import { AcademyError } from '../errors.js';
import type { CourseTeam } from '../team/course-team.js';

/** What the author is told: one notice per moderation event. */
export type ModerationNotice = {
  eventId: string;
  authorId: string;
  courseTitle: string;
  posts: number;
  reason: string;
};

/** The bus side of the outbox. `null` when svc-academy could not reach the bus: notices wait and are sent later. */
export interface ModerationNoticePublisher {
  publish(notice: ModerationNotice): Promise<void>;
}

type EventRow = {
  id: string;
  course_id: string;
  action: 'delete' | 'bulk_delete';
  post_id: string | null;
  author_id: string;
  posts: number;
  actor_id: string;
  reason: string;
  recorded_at: Date;
};

const eventView = (row: EventRow): AcademyModerationEvent => ({
  id: row.id,
  courseId: row.course_id,
  action: row.action,
  postId: row.post_id,
  authorId: row.author_id,
  posts: row.posts,
  actorId: row.actor_id,
  reason: row.reason,
  recordedAt: row.recorded_at,
});

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new AcademyError('academy.reason_required a deletion keeps who made it and why', 'academy.reason_required');
  return trimmed;
}

export type Moderator = { userId: string; mayWrite: boolean };

export class DiscussionModeration {
  constructor(
    private readonly sql: Sql,
    private readonly team: CourseTeam,
    private readonly notices: ModerationNoticePublisher | null,
    private readonly log: (err: unknown, eventId: string) => void = () => undefined,
  ) {}

  /** A learner enrolled in the published course reports a post or reply that is still showing. */
  async report(input: { userId: string; postId: string; reason: string; now: Date }): Promise<{ postId: string; reported: boolean }> {
    const [post] = await this.sql<{ id: string; course_id: string }[]>`
      SELECT p.id, p.course_id FROM academy.discussion_posts p JOIN academy.courses c ON c.id = p.course_id
       WHERE p.id = ${input.postId} AND p.removed_at IS NULL AND c.state = 'published'
         AND (p.parent_id IS NULL OR EXISTS (SELECT 1 FROM academy.discussion_posts t WHERE t.id = p.parent_id AND t.removed_at IS NULL))
    `;
    if (!post) throw new AcademyError(`academy.post_not_found post=${input.postId}`, 'academy.post_not_found');
    const [enrolled] = await this.sql`
      SELECT 1 FROM academy.course_enrolments WHERE course_id = ${post.course_id} AND user_id = ${input.userId} AND left_at IS NULL
    `;
    if (!enrolled)
      throw new AcademyError('academy.enrolment_required enrol in this course to report in its discussion', 'academy.enrolment_required');
    const reason = input.reason.trim();
    if (!reason) throw new AcademyError('academy.reason_required say why you report it', 'academy.reason_required');
    const rows = await this.sql`
      INSERT INTO academy.discussion_reports (post_id, reporter_id, reason, created_at)
      VALUES (${post.id}, ${input.userId}, ${reason}, ${input.now})
      ON CONFLICT (post_id, reporter_id) DO NOTHING
      RETURNING post_id
    `;
    return { postId: post.id, reported: rows.length === 1 };
  }

  /** Reported entries still showing, oldest report first, and the moderation events newest first. */
  async queue(input: { courseId: string | null; limit: number; caller: Moderator }): Promise<AcademyModerationQueue> {
    const course = input.courseId;
    const rows = await this.sql<
      {
        id: string;
        course_id: string;
        slug: string;
        course_title: string;
        parent_id: string | null;
        title: string | null;
        body: string;
        author_id: string;
        anonymous: boolean;
        created_at: Date;
        reports: number;
        reasons: string[];
        first_at: Date;
      }[]
    >`
      SELECT p.id, p.course_id, c.slug, c.title AS course_title, p.parent_id, p.title, p.body, p.author_id, p.anonymous,
             p.created_at, count(r.*)::int AS reports, array_agg(r.reason ORDER BY r.created_at) AS reasons,
             min(r.created_at) AS first_at
        FROM academy.discussion_reports r
        JOIN academy.discussion_posts p ON p.id = r.post_id
        JOIN academy.courses c ON c.id = p.course_id
       WHERE p.removed_at IS NULL
         AND (p.parent_id IS NULL OR EXISTS (SELECT 1 FROM academy.discussion_posts t WHERE t.id = p.parent_id AND t.removed_at IS NULL))
         ${course ? this.sql`AND p.course_id = ${course}` : this.sql``}
       GROUP BY p.id, c.slug, c.title
       ORDER BY min(r.created_at), p.id
       LIMIT ${input.limit}
    `;
    const events = await this.sql<EventRow[]>`
      SELECT id, course_id, action, post_id, author_id, posts, actor_id, reason, recorded_at FROM academy.moderation_events
       ${course ? this.sql`WHERE course_id = ${course}` : this.sql``}
       ORDER BY recorded_at DESC, id LIMIT ${input.limit}
    `;
    const may = new Map<string, boolean>();
    const mayModerate = async (courseId: string) => {
      if (!input.caller.mayWrite) return false;
      if (!may.has(courseId))
        may.set(courseId, (await this.team.permissionsOf(input.caller.userId, courseId)).permissions.includes('discussion.moderate'));
      return may.get(courseId)!;
    };
    const reports: AcademyModerationReport[] = [];
    for (const r of rows)
      reports.push({
        postId: r.id,
        courseId: r.course_id,
        courseSlug: r.slug,
        courseTitle: r.course_title,
        threadId: r.parent_id ?? r.id,
        isReply: r.parent_id !== null,
        title: r.title,
        body: r.body,
        authorId: r.author_id,
        anonymous: r.anonymous,
        postedAt: r.created_at,
        reports: r.reports,
        reasons: r.reasons,
        firstReportedAt: r.first_at,
        mayModerate: await mayModerate(r.course_id),
      });
    return { reports, events: events.map(eventView), mayWrite: input.caller.mayWrite };
  }

  private requireWrite(caller: Moderator): void {
    if (!caller.mayWrite)
      throw new AcademyError('academy.permission_denied this session may read the queue but not delete', 'academy.permission_denied');
  }

  /** Delete one post (its replies leave learner reads with it) or one reply, with a reason. A repeat answers with the first event. */
  async deletePost(input: { postId: string; reason: string; caller: Moderator; now: Date }): Promise<AcademyModerationEvent> {
    this.requireWrite(input.caller);
    const reason = requireReason(input.reason);
    const event = await transaction(this.sql, async (tx) => {
      const [post] = await tx<{ id: string; course_id: string; author_id: string; removed_at: Date | null }[]>`
        SELECT id, course_id, author_id, removed_at FROM academy.discussion_posts WHERE id = ${input.postId} FOR UPDATE
      `;
      if (!post) throw new AcademyError(`academy.post_not_found post=${input.postId}`, 'academy.post_not_found');
      await this.team.require(input.caller.userId, post.course_id, 'discussion.moderate', tx);
      const key = `moderate:${post.id}:delete`;
      const [again] = await tx<EventRow[]>`SELECT * FROM academy.moderation_events WHERE event_key = ${key}`;
      if (again) return again;
      if (post.removed_at) throw new AcademyError(`academy.post_not_found post=${input.postId}`, 'academy.post_not_found');
      await tx`
        UPDATE academy.discussion_posts SET removed_at = ${input.now}, removed_by = ${input.caller.userId}, removed_reason = ${reason}
         WHERE id = ${post.id}
      `;
      const [row] = await tx<EventRow[]>`
        INSERT INTO academy.moderation_events (course_id, action, post_id, author_id, posts, actor_id, reason, event_key, recorded_at)
        VALUES (${post.course_id}, 'delete', ${post.id}, ${post.author_id}, 1, ${input.caller.userId}, ${reason}, ${key}, ${input.now})
        RETURNING *
      `;
      return row!;
    });
    await this.sendWaiting();
    return eventView(event);
  }

  /** Delete every post and reply of one author in one course that is still showing; their posts in other courses stay. */
  async bulkDelete(input: {
    courseId: string;
    authorId: string;
    reason: string;
    caller: Moderator;
    now: Date;
  }): Promise<AcademyModerationEvent> {
    this.requireWrite(input.caller);
    const reason = requireReason(input.reason);
    const event = await transaction(this.sql, async (tx) => {
      const [course] = await tx`SELECT 1 FROM academy.courses WHERE id = ${input.courseId}`;
      if (!course) throw new AcademyError(`academy.course_not_found course=${input.courseId}`, 'academy.course_not_found');
      await this.team.require(input.caller.userId, input.courseId, 'discussion.moderate', tx);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`moderate:${input.courseId}:${input.authorId}`}))`;
      const removed = await tx`
        UPDATE academy.discussion_posts SET removed_at = ${input.now}, removed_by = ${input.caller.userId}, removed_reason = ${reason}
         WHERE course_id = ${input.courseId} AND author_id = ${input.authorId} AND removed_at IS NULL
        RETURNING id
      `;
      const [n] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM academy.moderation_events
         WHERE course_id = ${input.courseId} AND author_id = ${input.authorId} AND action = 'bulk_delete'
      `;
      const key = `moderate:${input.courseId}:${input.authorId}:bulk:${n!.n + 1}`;
      const [row] = await tx<EventRow[]>`
        INSERT INTO academy.moderation_events (course_id, action, post_id, author_id, posts, actor_id, reason, event_key, recorded_at, notified_at)
        VALUES (${input.courseId}, 'bulk_delete', NULL, ${input.authorId}, ${removed.length}, ${input.caller.userId}, ${reason}, ${key},
                ${input.now}, ${removed.length === 0 ? input.now : null})
        RETURNING *
      `;
      return row!;
    });
    await this.sendWaiting();
    return eventView(event);
  }

  /** Send every author notice still waiting, oldest first. A failure leaves it waiting for the next action or boot. */
  async sendWaiting(): Promise<number> {
    if (!this.notices) return 0;
    const waiting = await this.sql<{ id: string; author_id: string; posts: number; reason: string; course_title: string }[]>`
      SELECT e.id, e.author_id, e.posts, e.reason, c.title AS course_title
        FROM academy.moderation_events e JOIN academy.courses c ON c.id = e.course_id
       WHERE e.notified_at IS NULL ORDER BY e.recorded_at, e.id LIMIT 100
    `;
    let sent = 0;
    for (const w of waiting) {
      try {
        await this.notices.publish({ eventId: w.id, authorId: w.author_id, courseTitle: w.course_title, posts: w.posts, reason: w.reason });
        await this.sql`UPDATE academy.moderation_events SET notified_at = now() WHERE id = ${w.id} AND notified_at IS NULL`;
        sent += 1;
      } catch (err) {
        this.log(err, w.id);
        break;
      }
    }
    return sent;
  }
}
