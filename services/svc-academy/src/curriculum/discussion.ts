/**
 * AC-rooms-01 — the discussion of a course staff made: topics, posts, replies, the accepted answer, follow and like.
 *
 * Every course has a default General topic, which is not a row; staff add course-wide topics with a pin and a position,
 * and pinned topics always come first. Only a learner enrolled in the published course reads or writes its discussion;
 * the account always comes from the signed principal. An anonymous post hides its author from classmates only: the
 * account is stored, and staff read it. A post may carry one image, checked by its leading bytes and kept here under the
 * owner's size limit. Post length and image size are owner values with no default (`ACADEMY_POST_MAX_CHARS`,
 * `ACADEMY_POST_IMAGE_MAX_BYTES`): a post while the length is blank refuses `academy.post_limit_unset`, and an image while
 * the size is blank refuses `academy.attachment_limit_unset`. A retry with the same client request id answers with the
 * stored post (`post:<account>:<request>`). No money moves here.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import {
  ACADEMY_DISCUSSION_GENERAL_TOPIC,
  ACADEMY_DISCUSSION_IMAGE_TYPES,
  type AcademyCreateDiscussionPostInput,
  type AcademyDiscussionAuthor,
  type AcademyDiscussionCourse,
  type AcademyDiscussionImage,
  type AcademyDiscussionPost,
  type AcademyDiscussionPostKind,
  type AcademyDiscussionReply,
  type AcademyDiscussionThread,
  type AcademyDiscussionTopic,
  type AcademyDiscussionTopics,
  type AcademyReplyDiscussionPostInput,
  type AcademySaveDiscussionTopicInput,
  type AcademyStaffDiscussionThread,
} from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import { AcademyError } from '../errors.js';
import { FILE_SIGNATURES, signatureMatches } from './media.js';

type Db = Sql | TransactionSql;

export type DiscussionLimits = { postMaxChars: number | null; imageMaxBytes: number | null };

type CourseRow = { id: string; slug: string; title: string };
type PostRow = {
  id: string;
  course_id: string;
  topic_slug: string;
  parent_id: string | null;
  kind: AcademyDiscussionPostKind | null;
  title: string | null;
  body: string;
  author_id: string;
  anonymous: boolean;
  image_type: string | null;
  accepted_reply_id: string | null;
  created_at: Date;
  replies: number;
  likes: number;
  liked: boolean;
  following: boolean;
};

const GENERAL_TITLE = 'General';
/** What staff read of a post: never its image bytes. */
const STAFF_COLUMNS = ['id', 'course_id', 'topic_slug', 'kind', 'title', 'body', 'author_id', 'anonymous', 'created_at'] as const;
const IMAGE_TYPES: readonly string[] = ACADEMY_DISCUSSION_IMAGE_TYPES;

/** A classmate's name within one course: stable for the course, and no account id. */
export const classmateLabel = (courseId: string, userId: string) =>
  `Learner ${createHash('sha256').update(`discussion:${courseId}:${userId}`).digest('hex').slice(0, 6)}`;

function authorOf(row: Pick<PostRow, 'course_id' | 'author_id' | 'anonymous'>, readerId: string): AcademyDiscussionAuthor {
  if (row.author_id === readerId) return { kind: 'you', anonymous: row.anonymous };
  if (row.anonymous) return { kind: 'anonymous' };
  return { kind: 'learner', label: classmateLabel(row.course_id, row.author_id) };
}

const postView = (row: PostRow, readerId: string): AcademyDiscussionPost => ({
  id: row.id,
  topicSlug: row.topic_slug,
  kind: row.kind!,
  title: row.title!,
  body: row.body,
  author: authorOf(row, readerId),
  createdAt: row.created_at,
  replies: row.replies,
  likes: row.likes,
  liked: row.liked,
  following: row.following,
  acceptedReplyId: row.accepted_reply_id,
  hasImage: row.image_type !== null,
});

const replyView = (row: PostRow, readerId: string, acceptedId: string | null): AcademyDiscussionReply => ({
  id: row.id,
  body: row.body,
  author: authorOf(row, readerId),
  createdAt: row.created_at,
  likes: row.likes,
  liked: row.liked,
  accepted: row.id === acceptedId,
});

/** Pure: the decoded image, or the typed refusal for one the owner's limit or the type check does not allow. */
export function checkDiscussionImage(image: { contentType: string; base64: string }, maxBytes: number | null): Buffer {
  if (!IMAGE_TYPES.includes(image.contentType) || !FILE_SIGNATURES[image.contentType])
    throw new AcademyError(
      `academy.attachment_type_refused ${image.contentType} is not an image a post takes`,
      'academy.attachment_type_refused',
    );
  if (maxBytes === null) throw new AcademyError('academy.attachment_limit_unset', 'academy.attachment_limit_unset');
  const bytes = Buffer.from(image.base64, 'base64');
  if (bytes.byteLength === 0)
    throw new AcademyError('academy.attachment_type_refused the image is empty', 'academy.attachment_type_refused');
  if (bytes.byteLength > maxBytes)
    throw new AcademyError(`academy.attachment_too_large bytes=${bytes.byteLength} max=${maxBytes}`, 'academy.attachment_too_large');
  if (!signatureMatches(bytes.subarray(0, 16), FILE_SIGNATURES[image.contentType]!))
    throw new AcademyError(
      `academy.attachment_type_refused declared ${image.contentType} but the content is not`,
      'academy.attachment_type_refused',
    );
  return bytes;
}

/** Pure: refuses a post body while the owner's length is blank, or over it. */
export function checkPostLength(body: string, maxChars: number | null): void {
  if (maxChars === null) throw new AcademyError('academy.post_limit_unset', 'academy.post_limit_unset');
  const chars = [...body].length;
  if (chars > maxChars) throw new AcademyError(`academy.post_too_long chars=${chars} max=${maxChars}`, 'academy.post_too_long');
}

export class CourseDiscussion {
  constructor(
    private readonly sql: Sql,
    private readonly limits: DiscussionLimits,
  ) {}

  /** The published course at that address, or `academy.course_not_found`. */
  private async course(db: Db, slug: string): Promise<CourseRow> {
    const [row] = await db<CourseRow[]>`SELECT id, slug, title FROM academy.courses WHERE slug = ${slug} AND state = 'published'`;
    if (!row) throw new AcademyError(`academy.course_not_found slug=${slug}`, 'academy.course_not_found');
    return row;
  }

  /** Refuses `academy.enrolment_required` unless the reader holds an open enrolment in the course. */
  private async assertEnrolled(db: Db, courseId: string, userId: string): Promise<void> {
    const [row] = await db<{ enrolled: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM academy.course_enrolments
        WHERE course_id = ${courseId} AND user_id = ${userId} AND left_at IS NULL) AS enrolled
    `;
    if (!row?.enrolled)
      throw new AcademyError('academy.enrolment_required enrol in this course to join its discussion', 'academy.enrolment_required');
  }

  private async enrolledCourse(db: Db, slug: string, userId: string): Promise<CourseRow> {
    const course = await this.course(db, slug);
    await this.assertEnrolled(db, course.id, userId);
    return course;
  }

  private async assertTopic(db: Db, courseId: string, topicSlug: string): Promise<void> {
    if (topicSlug === ACADEMY_DISCUSSION_GENERAL_TOPIC) return;
    const [row] = await db`SELECT 1 FROM academy.discussion_topics WHERE course_id = ${courseId} AND slug = ${topicSlug}`;
    if (!row) throw new AcademyError(`academy.topic_not_found topic=${topicSlug}`, 'academy.topic_not_found');
  }

  private rows(
    db: Db,
    readerId: string,
    where: {
      id?: string;
      parent?: { id: string; accepted: string | null; limit: number };
      topic?: { courseId: string; slug: string; limit: number };
    },
  ) {
    return db<PostRow[]>`
      SELECT p.id, p.course_id, p.topic_slug, p.parent_id, p.kind, p.title, p.body, p.author_id, p.anonymous, p.image_type,
             p.accepted_reply_id, p.created_at,
             (SELECT count(*)::int FROM academy.discussion_posts r WHERE r.parent_id = p.id) AS replies,
             (SELECT count(*)::int FROM academy.discussion_likes l WHERE l.post_id = p.id) AS likes,
             EXISTS (SELECT 1 FROM academy.discussion_likes l WHERE l.post_id = p.id AND l.user_id = ${readerId}) AS liked,
             EXISTS (SELECT 1 FROM academy.discussion_follows f WHERE f.post_id = p.id AND f.user_id = ${readerId}) AS following
        FROM academy.discussion_posts p
       WHERE ${
         where.id !== undefined
           ? db`p.id = ${where.id}`
           : where.parent !== undefined
             ? db`p.parent_id = ${where.parent.id}`
             : db`p.parent_id IS NULL AND p.course_id = ${where.topic!.courseId} AND p.topic_slug = ${where.topic!.slug}`
       }
       ORDER BY ${
         where.parent !== undefined
           ? db`(p.id = ${where.parent.accepted}::uuid) IS TRUE DESC, p.created_at, p.id`
           : db`p.created_at DESC, p.id`
       }
       ${where.topic ? db`LIMIT ${where.topic.limit}` : where.parent ? db`LIMIT ${where.parent.limit}` : db``}
    `;
  }

  /** The post or reply with that id in a course the reader is enrolled in, or `academy.post_not_found`. */
  private async entry(db: Db, postId: string, readerId: string): Promise<PostRow> {
    const [row] = await this.rows(db, readerId, { id: postId });
    if (!row) throw new AcademyError(`academy.post_not_found post=${postId}`, 'academy.post_not_found');
    const [published] = await db`SELECT 1 FROM academy.courses WHERE id = ${row.course_id} AND state = 'published'`;
    if (!published) throw new AcademyError(`academy.post_not_found post=${postId}`, 'academy.post_not_found');
    await this.assertEnrolled(db, row.course_id, readerId);
    return row;
  }

  /** The published courses the reader is enrolled in, newest enrolment first: the Rooms tab's way into each discussion. */
  async courses(userId: string, limit: number): Promise<AcademyDiscussionCourse[]> {
    const rows = await this.sql<CourseRow[]>`
      SELECT c.id, c.slug, c.title
        FROM academy.course_enrolments e JOIN academy.courses c ON c.id = e.course_id
       WHERE e.user_id = ${userId} AND e.left_at IS NULL AND c.state = 'published'
       ORDER BY e.enrolled_at DESC, c.id
       LIMIT ${limit}
    `;
    return rows.map((row) => ({ courseId: row.id, slug: row.slug, title: row.title }));
  }

  /** The course's topics in order: pinned first, then by position; General sits at position 0 and is never pinned. */
  async topics(input: { userId: string; courseSlug: string }): Promise<AcademyDiscussionTopics> {
    const course = await this.enrolledCourse(this.sql, input.courseSlug, input.userId);
    const rows = await this.sql<{ slug: string; title: string; pinned: boolean; position: number; created_at: Date }[]>`
      SELECT slug, title, pinned, position, created_at FROM academy.discussion_topics WHERE course_id = ${course.id}
    `;
    const counts = await this.sql<{ topic_slug: string; posts: number }[]>`
      SELECT topic_slug, count(*)::int AS posts FROM academy.discussion_posts
       WHERE course_id = ${course.id} AND parent_id IS NULL GROUP BY topic_slug
    `;
    const postsIn = (slug: string) => counts.find((c) => c.topic_slug === slug)?.posts ?? 0;
    const topics: (AcademyDiscussionTopic & { at: number })[] = [
      { slug: ACADEMY_DISCUSSION_GENERAL_TOPIC, title: GENERAL_TITLE, pinned: false, position: 0, general: true, posts: 0, at: 0 },
      ...rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        pinned: r.pinned,
        position: r.position,
        general: false,
        posts: 0,
        at: r.created_at.getTime(),
      })),
    ];
    topics.sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position || Number(b.general) - Number(a.general) || a.at - b.at,
    );
    return {
      course: { courseId: course.id, slug: course.slug, title: course.title },
      topics: topics.map(({ at: _at, ...t }) => ({ ...t, posts: postsIn(t.slug) })),
    };
  }

  /** One topic's posts, newest first. */
  async posts(input: { userId: string; courseSlug: string; topicSlug: string; limit: number }): Promise<AcademyDiscussionPost[]> {
    const course = await this.enrolledCourse(this.sql, input.courseSlug, input.userId);
    await this.assertTopic(this.sql, course.id, input.topicSlug);
    const rows = await this.rows(this.sql, input.userId, { topic: { courseId: course.id, slug: input.topicSlug, limit: input.limit } });
    return rows.map((row) => postView(row, input.userId));
  }

  /** A post and up to `limit` replies: the accepted answer first, then oldest first. A reply's id opens nothing here. */
  async thread(input: { userId: string; postId: string; limit: number }): Promise<AcademyDiscussionThread> {
    const post = await this.entry(this.sql, input.postId, input.userId);
    if (post.parent_id !== null) throw new AcademyError(`academy.post_not_found post=${input.postId}`, 'academy.post_not_found');
    const [course] = await this.sql<CourseRow[]>`SELECT id, slug, title FROM academy.courses WHERE id = ${post.course_id}`;
    const accepted = post.accepted_reply_id;
    const replies = await this.rows(this.sql, input.userId, { parent: { id: post.id, accepted, limit: input.limit } });
    return {
      course: { courseId: course!.id, slug: course!.slug, title: course!.title },
      post: postView(post, input.userId),
      replies: replies.map((row) => replyView(row, input.userId, accepted)),
      canAccept: post.kind === 'question' && post.author_id === input.userId,
    };
  }

  /** A post's image, or null when it has none. */
  async image(input: { userId: string; postId: string }): Promise<AcademyDiscussionImage | null> {
    const post = await this.entry(this.sql, input.postId, input.userId);
    if (post.image_type === null) return null;
    const [stored] = await this.sql<{ image: Buffer }[]>`SELECT image FROM academy.discussion_posts WHERE id = ${post.id}`;
    return { contentType: post.image_type as AcademyDiscussionImage['contentType'], base64: stored!.image.toString('base64') };
  }

  /**
   * The row an earlier send with this request id stored, or null. A request id answers only the same send: a different
   * post, reply, text or image under it refuses `academy.request_reused`, so an edited draft is never dropped in silence.
   */
  private async byRequest(
    userId: string,
    clientRequestId: string,
    same: {
      parentId: string | null;
      topicSlug: string;
      kind: string | null;
      title: string | null;
      body: string;
      anonymous: boolean;
      image: Buffer | null;
    },
  ): Promise<PostRow | null> {
    const [found] = await this.sql<{ id: string; same: boolean }[]>`
      SELECT id,
             (parent_id IS NOT DISTINCT FROM ${same.parentId}::uuid AND topic_slug = ${same.topicSlug}
              AND kind IS NOT DISTINCT FROM ${same.kind}::text AND title IS NOT DISTINCT FROM ${same.title}::text
              AND body = ${same.body} AND anonymous = ${same.anonymous} AND image IS NOT DISTINCT FROM ${same.image}::bytea) AS same
        FROM academy.discussion_posts WHERE author_id = ${userId} AND client_request_id = ${clientRequestId}
    `;
    if (!found) return null;
    if (!found.same)
      throw new AcademyError(`academy.request_reused request=${clientRequestId} answers another post`, 'academy.request_reused');
    const [row] = await this.rows(this.sql, userId, { id: found.id });
    return row!;
  }

  /** A new question or discussion. A retry with the same client request id answers with the stored post. */
  async createPost(input: AcademyCreateDiscussionPostInput & { userId: string; now: Date }): Promise<AcademyDiscussionPost> {
    const course = await this.enrolledCourse(this.sql, input.courseSlug, input.userId);
    await this.assertTopic(this.sql, course.id, input.topicSlug);
    checkPostLength(input.body, this.limits.postMaxChars);
    const image = input.image ? checkDiscussionImage(input.image, this.limits.imageMaxBytes) : null;
    const same = {
      parentId: null,
      topicSlug: input.topicSlug,
      kind: input.kind,
      title: input.title,
      body: input.body,
      anonymous: input.anonymous,
      image,
    };
    const stored = await this.byRequest(input.userId, input.clientRequestId, same);
    if (stored) return postView(stored, input.userId);
    await this.sql`
      INSERT INTO academy.discussion_posts
        (course_id, topic_slug, kind, title, body, author_id, anonymous, image_type, image, client_request_id, created_at)
      VALUES (${course.id}, ${input.topicSlug}, ${input.kind}, ${input.title}, ${input.body}, ${input.userId}, ${input.anonymous},
              ${input.image ? input.image.contentType : null}, ${image}, ${input.clientRequestId}, ${input.now})
      ON CONFLICT (author_id, client_request_id) DO NOTHING
    `;
    return postView((await this.byRequest(input.userId, input.clientRequestId, same))!, input.userId);
  }

  /** A reply to a post. Replies nest one level: a reply to a reply refuses `academy.post_not_found`. */
  async reply(input: AcademyReplyDiscussionPostInput & { userId: string; now: Date }): Promise<AcademyDiscussionReply> {
    const post = await this.entry(this.sql, input.postId, input.userId);
    if (post.parent_id !== null) throw new AcademyError(`academy.post_not_found post=${input.postId}`, 'academy.post_not_found');
    checkPostLength(input.body, this.limits.postMaxChars);
    const same = {
      parentId: post.id,
      topicSlug: post.topic_slug,
      kind: null,
      title: null,
      body: input.body,
      anonymous: input.anonymous,
      image: null,
    };
    const stored = await this.byRequest(input.userId, input.clientRequestId, same);
    if (stored) return replyView(stored, input.userId, post.accepted_reply_id);
    await this.sql`
      INSERT INTO academy.discussion_posts (course_id, topic_slug, parent_id, body, author_id, anonymous, client_request_id, created_at)
      VALUES (${post.course_id}, ${post.topic_slug}, ${post.id}, ${input.body}, ${input.userId}, ${input.anonymous},
              ${input.clientRequestId}, ${input.now})
      ON CONFLICT (author_id, client_request_id) DO NOTHING
    `;
    return replyView((await this.byRequest(input.userId, input.clientRequestId, same))!, input.userId, post.accepted_reply_id);
  }

  /** The asker marks one reply of their question as accepted; marking another moves the mark. */
  async accept(input: { userId: string; postId: string; replyId: string }): Promise<{ postId: string; acceptedReplyId: string }> {
    return transaction(this.sql, async (tx) => {
      const post = await this.entry(tx, input.postId, input.userId);
      if (post.parent_id !== null) throw new AcademyError(`academy.post_not_found post=${input.postId}`, 'academy.post_not_found');
      if (post.kind !== 'question' || post.author_id !== input.userId)
        throw new AcademyError('academy.permission_denied only the asker marks the accepted answer', 'academy.permission_denied');
      const [reply] = await tx`SELECT 1 FROM academy.discussion_posts WHERE id = ${input.replyId} AND parent_id = ${post.id}`;
      if (!reply) throw new AcademyError(`academy.post_not_found reply=${input.replyId}`, 'academy.post_not_found');
      await tx`UPDATE academy.discussion_posts SET accepted_reply_id = ${input.replyId} WHERE id = ${post.id}`;
      return { postId: post.id, acceptedReplyId: input.replyId };
    });
  }

  /** Follow a post, or stop. Set-style: a repeat changes nothing. */
  async follow(input: { userId: string; postId: string; on: boolean; now: Date }): Promise<{ postId: string; on: boolean }> {
    const post = await this.entry(this.sql, input.postId, input.userId);
    if (post.parent_id !== null) throw new AcademyError(`academy.post_not_found post=${input.postId}`, 'academy.post_not_found');
    if (input.on)
      await this
        .sql`INSERT INTO academy.discussion_follows (post_id, user_id, created_at) VALUES (${post.id}, ${input.userId}, ${input.now}) ON CONFLICT DO NOTHING`;
    else await this.sql`DELETE FROM academy.discussion_follows WHERE post_id = ${post.id} AND user_id = ${input.userId}`;
    return { postId: post.id, on: input.on };
  }

  /** Like a post or a reply, or take the like back. Set-style: a repeat changes nothing. */
  async like(input: { userId: string; postId: string; on: boolean; now: Date }): Promise<{ postId: string; on: boolean; likes: number }> {
    const entry = await this.entry(this.sql, input.postId, input.userId);
    if (input.on)
      await this
        .sql`INSERT INTO academy.discussion_likes (post_id, user_id, created_at) VALUES (${entry.id}, ${input.userId}, ${input.now}) ON CONFLICT DO NOTHING`;
    else await this.sql`DELETE FROM academy.discussion_likes WHERE post_id = ${entry.id} AND user_id = ${input.userId}`;
    const [count] = await this.sql<
      { likes: number }[]
    >`SELECT count(*)::int AS likes FROM academy.discussion_likes WHERE post_id = ${entry.id}`;
    return { postId: entry.id, on: input.on, likes: count!.likes };
  }

  /** Staff: create a topic, or change its title, pin and position, with an event row naming the operator and the reason. */
  async saveTopic(input: AcademySaveDiscussionTopicInput & { operatorId: string; now: Date }): Promise<AcademyDiscussionTopic> {
    return transaction(this.sql, async (tx) => {
      const [course] = await tx`SELECT 1 FROM academy.courses WHERE id = ${input.courseId}`;
      if (!course) throw new AcademyError(`academy.course_not_found course=${input.courseId}`, 'academy.course_not_found');
      await tx`
        INSERT INTO academy.discussion_topics (course_id, slug, title, pinned, position, created_by, created_at, updated_at)
        VALUES (${input.courseId}, ${input.slug}, ${input.title}, ${input.pinned}, ${input.position}, ${input.operatorId}, ${input.now}, ${input.now})
        ON CONFLICT (course_id, slug) DO UPDATE SET
          title = EXCLUDED.title, pinned = EXCLUDED.pinned, position = EXCLUDED.position, updated_at = EXCLUDED.updated_at
      `;
      await tx`
        INSERT INTO academy.discussion_topic_events (course_id, slug, title, pinned, position, operator_id, reason, recorded_at)
        VALUES (${input.courseId}, ${input.slug}, ${input.title}, ${input.pinned}, ${input.position}, ${input.operatorId}, ${input.reason}, ${input.now})
      `;
      const [posts] = await tx<{ posts: number }[]>`
        SELECT count(*)::int AS posts FROM academy.discussion_posts
         WHERE course_id = ${input.courseId} AND topic_slug = ${input.slug} AND parent_id IS NULL
      `;
      return { slug: input.slug, title: input.title, pinned: input.pinned, position: input.position, general: false, posts: posts!.posts };
    });
  }

  /** Staff: a post and its replies with the account behind each, anonymous or not. */
  async staffThread(postId: string, limit: number): Promise<AcademyStaffDiscussionThread> {
    const [post] = await this.sql<PostRow[]>`
      SELECT ${this.sql(STAFF_COLUMNS)} FROM academy.discussion_posts WHERE id = ${postId} AND parent_id IS NULL
    `;
    if (!post) throw new AcademyError(`academy.post_not_found post=${postId}`, 'academy.post_not_found');
    const replies = await this.sql<PostRow[]>`
      SELECT ${this.sql(STAFF_COLUMNS)} FROM academy.discussion_posts WHERE parent_id = ${postId} ORDER BY created_at, id LIMIT ${limit}
    `;
    const entry = (row: PostRow) => ({
      id: row.id,
      authorId: row.author_id,
      anonymous: row.anonymous,
      body: row.body,
      createdAt: row.created_at,
    });
    return {
      post: { ...entry(post), courseId: post.course_id, topicSlug: post.topic_slug, kind: post.kind!, title: post.title! },
      replies: replies.map(entry),
    };
  }
}
