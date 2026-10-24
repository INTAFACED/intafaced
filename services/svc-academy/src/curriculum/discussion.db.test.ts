/**
 * AC-rooms-01: course discussions against Postgres. Topics come pinned first with General; only enrolled learners read and
 * post; a retry is one post; a non-image or oversized file and a blank owner value refuse by name; the asker's accepted
 * answer moves; follow and like are set once; an anonymous post hides its author from classmates and not from staff.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from './courses.js';
import { CourseDiscussion, classmateLabel, type DiscussionLimits } from './discussion.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzle, name), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const db: TestDatabase = await createTestDatabase({ service: 'academy', url: adminUrl(), migrations: MIGRATIONS });
const sql = db.sql;
const STAFF = '33333333-3333-4333-8333-333333333333';
const ME = '55555555-5555-4555-8555-555555555555';
const PEER = '66666666-6666-4666-8666-666666666666';
const STRANGER = '77777777-7777-4777-8777-777777777777';
const NOW = new Date('2026-10-24T19:00:00.000Z');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const LIMITS: DiscussionLimits = { postMaxChars: 100, imageMaxBytes: 1024 };

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

const discussion = (limits: Partial<DiscussionLimits> = {}) => new CourseDiscussion(sql, { ...LIMITS, ...limits });

/** A published free course with one lesson, and enrolments for ME and PEER. */
async function course(slug = 'risk-basics') {
  const records = new CourseRecords(sql, { maxSections: 5, maxItems: 5 });
  const made = await records.create({
    slug,
    title: `TEST ${slug}`,
    summary: null,
    thumbnailUrl: null,
    pricing: 'free',
    price: null,
    priceAsset: null,
    operatorId: STAFF,
    now: NOW,
  });
  const detail = await records.saveOutline({
    courseId: made.id,
    revision: 1,
    sections: [{ title: 'Start', items: [{ kind: 'lesson', title: 'One', indent: 0, url: null }] }],
    operatorId: STAFF,
    now: NOW,
  });
  await records.setState({
    courseId: made.id,
    to: 'published',
    revision: detail.course.revision,
    reason: 'TEST',
    operatorId: STAFF,
    now: NOW,
  });
  for (const user of [ME, PEER])
    await sql`INSERT INTO academy.course_enrolments (course_id, user_id, track, enrolled_at) VALUES (${made.id}, ${user}, 'audit', ${NOW})`;
  return made;
}

const post = (d: CourseDiscussion, over: Record<string, unknown> = {}) =>
  d.createPost({
    courseSlug: 'risk-basics',
    topicSlug: 'general',
    kind: 'question',
    title: 'TEST How big?',
    body: 'TEST How big should one trade be?',
    anonymous: false,
    image: null,
    clientRequestId: 'post:1',
    userId: ME,
    now: NOW,
    ...over,
  } as Parameters<CourseDiscussion['createPost']>[0]);

describe('course discussion', () => {
  it('lists General with pinned topics first, whatever their position, and an empty General', async () => {
    const c = await course();
    const d = discussion();
    await d.saveTopic({
      courseId: c.id,
      slug: 'week-one',
      title: 'Week one',
      pinned: false,
      position: 1,
      reason: 'TEST',
      operatorId: STAFF,
      now: NOW,
    });
    await d.saveTopic({
      courseId: c.id,
      slug: 'read-first',
      title: 'Read first',
      pinned: true,
      position: 9,
      reason: 'TEST',
      operatorId: STAFF,
      now: NOW,
    });
    const slugs = async () => (await d.topics({ userId: ME, courseSlug: 'risk-basics' })).topics.map((t) => t.slug);
    expect(await slugs()).toEqual(['read-first', 'general', 'week-one']);
    await d.saveTopic({
      courseId: c.id,
      slug: 'week-one',
      title: 'Week one',
      pinned: false,
      position: 0,
      reason: 'TEST',
      operatorId: STAFF,
      now: NOW,
    });
    expect((await slugs())[0]).toBe('read-first');
    expect(await d.posts({ userId: ME, courseSlug: 'risk-basics', topicSlug: 'general', limit: 50 })).toEqual([]);
    expect(await sql`SELECT count(*)::int AS n FROM academy.discussion_topic_events`).toEqual([{ n: 3 }]);
    await expect(d.posts({ userId: ME, courseSlug: 'risk-basics', topicSlug: 'nowhere', limit: 5 })).rejects.toMatchObject({
      code: 'academy.topic_not_found',
    });
  });

  it('refuses a learner who is not enrolled, and a course that is not published', async () => {
    await course();
    const d = discussion();
    await expect(d.topics({ userId: STRANGER, courseSlug: 'risk-basics' })).rejects.toMatchObject({ code: 'academy.enrolment_required' });
    await expect(post(d, { userId: STRANGER })).rejects.toMatchObject({ code: 'academy.enrolment_required' });
    await expect(d.topics({ userId: ME, courseSlug: 'no-such-course' })).rejects.toMatchObject({ code: 'academy.course_not_found' });
    expect(await d.courses(ME, 10)).toEqual([expect.objectContaining({ slug: 'risk-basics' })]);
    expect(await d.courses(STRANGER, 10)).toEqual([]);
  });

  it('makes one post of a retry, and refuses blank or exceeded owner values and a non-image file by name', async () => {
    await course();
    const d = discussion();
    const first = await post(d);
    expect(await post(d)).toEqual(first);
    await expect(Promise.all([post(d, { clientRequestId: 'post:2' }), post(d, { clientRequestId: 'post:2' })])).resolves.toHaveLength(2);
    expect(await sql`SELECT count(*)::int AS n FROM academy.discussion_posts`).toEqual([{ n: 2 }]);

    await expect(post(discussion({ postMaxChars: null }), { clientRequestId: 'post:3' })).rejects.toMatchObject({
      code: 'academy.post_limit_unset',
    });
    await expect(post(d, { clientRequestId: 'post:3', body: 'x'.repeat(101) })).rejects.toMatchObject({ code: 'academy.post_too_long' });
    const pdf = { contentType: 'application/pdf', base64: Buffer.from('%PDF-1.4\n').toString('base64') };
    await expect(post(d, { clientRequestId: 'post:3', image: pdf })).rejects.toMatchObject({ code: 'academy.attachment_type_refused' });
    // Declared as an image, but its bytes are not one.
    await expect(post(d, { clientRequestId: 'post:3', image: { contentType: 'image/png', base64: pdf.base64 } })).rejects.toMatchObject({
      code: 'academy.attachment_type_refused',
    });
    const svg = { contentType: 'image/svg+xml', base64: Buffer.from('<svg/>').toString('base64') };
    await expect(post(d, { clientRequestId: 'post:3', image: svg })).rejects.toMatchObject({ code: 'academy.attachment_type_refused' });
    const png = { contentType: 'image/png', base64: PNG };
    await expect(post(discussion({ imageMaxBytes: null }), { clientRequestId: 'post:3', image: png })).rejects.toMatchObject({
      code: 'academy.attachment_limit_unset',
    });
    await expect(post(discussion({ imageMaxBytes: 10 }), { clientRequestId: 'post:3', image: png })).rejects.toMatchObject({
      code: 'academy.attachment_too_large',
    });
    expect(await sql`SELECT count(*)::int AS n FROM academy.discussion_posts`).toEqual([{ n: 2 }]);
    const withImage = await post(d, { clientRequestId: 'post:3', image: png });
    expect(withImage.hasImage).toBe(true);
    expect(await d.image({ userId: PEER, postId: withImage.id })).toEqual({ contentType: 'image/png', base64: PNG });
    expect(await d.image({ userId: PEER, postId: first.id })).toBeNull();
    // A request id answers only the same send: an edited draft under it, or a reply under a post's id, is refused.
    await expect(post(d, { body: 'TEST edited' })).rejects.toMatchObject({ code: 'academy.request_reused' });
    await expect(
      d.reply({
        postId: first.id,
        body: 'TEST How big should one trade be?',
        anonymous: false,
        clientRequestId: 'post:1',
        userId: ME,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.request_reused' });
  });

  it('puts the accepted answer first, moves it on a second accept, and lets only the asker accept', async () => {
    await course();
    const d = discussion();
    const q = await post(d);
    const a = await d.reply({ postId: q.id, body: 'TEST One percent.', anonymous: false, clientRequestId: 'r:1', userId: PEER, now: NOW });
    const b = await d.reply({
      postId: q.id,
      body: 'TEST A fixed amount.',
      anonymous: false,
      clientRequestId: 'r:2',
      userId: PEER,
      now: new Date(NOW.getTime() + 1000),
    });
    // A retried reply is the same reply.
    expect(
      (await d.reply({ postId: q.id, body: 'TEST A fixed amount.', anonymous: false, clientRequestId: 'r:2', userId: PEER, now: NOW })).id,
    ).toBe(b.id);
    await expect(d.accept({ userId: PEER, postId: q.id, replyId: a.id })).rejects.toMatchObject({ code: 'academy.permission_denied' });
    await expect(
      d.reply({ postId: a.id, body: 'TEST nested', anonymous: false, clientRequestId: 'r:3', userId: ME, now: NOW }),
    ).rejects.toMatchObject({
      code: 'academy.post_not_found',
    });
    await d.accept({ userId: ME, postId: q.id, replyId: b.id });
    let thread = await d.thread({ userId: ME, postId: q.id, limit: 50 });
    expect(thread.replies.map((r) => [r.id, r.accepted])).toEqual([
      [b.id, true],
      [a.id, false],
    ]);
    await d.accept({ userId: ME, postId: q.id, replyId: a.id });
    thread = await d.thread({ userId: ME, postId: q.id, limit: 50 });
    expect(thread.replies.map((r) => [r.id, r.accepted])).toEqual([
      [a.id, true],
      [b.id, false],
    ]);
    expect(thread.canAccept).toBe(true);
    expect((await d.thread({ userId: PEER, postId: q.id, limit: 50 })).canAccept).toBe(false);
  });

  it('sets follow and like once, and takes them back', async () => {
    await course();
    const d = discussion();
    const q = await post(d);
    await d.follow({ userId: ME, postId: q.id, on: true, now: NOW });
    await d.follow({ userId: ME, postId: q.id, on: true, now: NOW });
    expect((await d.like({ userId: PEER, postId: q.id, on: true, now: NOW })).likes).toBe(1);
    expect((await d.like({ userId: PEER, postId: q.id, on: true, now: NOW })).likes).toBe(1);
    let view = (await d.thread({ userId: ME, postId: q.id, limit: 50 })).post;
    expect([view.following, view.likes, view.liked]).toEqual([true, 1, false]);
    await d.follow({ userId: ME, postId: q.id, on: false, now: NOW });
    expect((await d.like({ userId: PEER, postId: q.id, on: false, now: NOW })).likes).toBe(0);
    view = (await d.thread({ userId: ME, postId: q.id, limit: 50 })).post;
    expect([view.following, view.likes]).toEqual([false, 0]);
  });

  it('shows classmates no name or account for an anonymous post, and staff the account', async () => {
    const c = await course();
    const d = discussion();
    const named = await post(d);
    const anon = await post(d, { clientRequestId: 'post:anon', kind: 'discussion', title: 'TEST unsigned', anonymous: true });
    const seen = await d.posts({ userId: PEER, courseSlug: 'risk-basics', topicSlug: 'general', limit: 50 });
    expect(seen.find((p) => p.id === anon.id)!.author).toEqual({ kind: 'anonymous' });
    expect(JSON.stringify(seen)).not.toContain(ME);
    expect(seen.find((p) => p.id === named.id)!.author).toEqual({ kind: 'learner', label: classmateLabel(c.id, ME) });
    expect(anon.author).toEqual({ kind: 'you', anonymous: true });
    expect((await d.staffThread(anon.id, 50)).post).toMatchObject({ authorId: ME, anonymous: true });
  });
});
