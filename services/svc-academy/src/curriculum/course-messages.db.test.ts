/**
 * AC-rooms-04: messages to the course team against Postgres. An enrolled learner's message lands in their inbox and the
 * staff inbox, unread on the staff side; a staff reply turns the learner's marker on until they open it; a stranger and a
 * blank owner length refuse by name; a retry is one message; a learner never opens another learner's conversation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from './courses.js';
import { CourseMessages } from './course-messages.js';

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
const LATER = new Date('2026-10-24T19:05:00.000Z');
const LATEST = new Date('2026-10-24T19:10:00.000Z');

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

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

const messages = (max: number | null = 100) => new CourseMessages(sql, max);
const send = (m: CourseMessages, over: Record<string, unknown> = {}) =>
  m.send({
    courseSlug: 'risk-basics',
    body: 'TEST Is there a live session?',
    clientRequestId: 'msg:1',
    userId: ME,
    now: NOW,
    ...over,
  } as Parameters<CourseMessages['send']>[0]);

describe('course team messages', () => {
  it('stores the message in both inboxes, unread for staff, and names vendor.email for the mail copy', async () => {
    const c = await course();
    const m = messages();
    const sent = await send(m);
    expect(sent.mailCopy).toEqual({ state: 'not_connected', code: 'vendor.email' });
    expect(await send(m)).toEqual(sent);
    await expect(send(m, { body: 'TEST edited' })).rejects.toMatchObject({ code: 'academy.request_reused' });
    expect(await m.inbox(ME, 10)).toEqual([expect.objectContaining({ id: sent.conversationId, courseSlug: 'risk-basics', unread: false })]);
    expect(await m.staffInbox(10)).toEqual([
      expect.objectContaining({ id: sent.conversationId, courseId: c.id, learnerId: ME, staffUnread: true }),
    ]);
    // A second message is the same conversation.
    const again = await send(m, { clientRequestId: 'msg:2', body: 'TEST And a recording?', now: LATER });
    expect(again.conversationId).toBe(sent.conversationId);
    expect(await sql`SELECT count(*)::int AS n FROM academy.course_messages`).toEqual([{ n: 2 }]);
  });

  it('turns the learner marker on with a staff reply and off when they open it; staff opening clears theirs', async () => {
    await course();
    const m = messages();
    const sent = await send(m);
    const staffView = await m.staffOpen({ conversationId: sent.conversationId, limit: 50, now: LATER });
    expect(staffView.messages.map((x) => [x.from, x.senderId])).toEqual([['learner', ME]]);
    expect((await m.staffInbox(10))[0]!.staffUnread).toBe(false);
    await m.staffReply({
      conversationId: sent.conversationId,
      body: 'TEST Thursday.',
      clientRequestId: 'r:1',
      operatorId: STAFF,
      now: LATER,
    });
    expect((await m.inbox(ME, 10))[0]!.unread).toBe(true);
    const opened = await m.open({ userId: ME, conversationId: sent.conversationId, limit: 50, now: LATEST });
    expect(opened.messages.map((x) => [x.from, x.body])).toEqual([
      ['learner', 'TEST Is there a live session?'],
      ['staff', 'TEST Thursday.'],
    ]);
    expect((await m.inbox(ME, 10))[0]!.unread).toBe(false);
  });

  it('refuses a learner not enrolled, a blank or exceeded length, and another learner opening the conversation', async () => {
    await course();
    await expect(send(messages(), { userId: STRANGER })).rejects.toMatchObject({ code: 'academy.enrolment_required' });
    await expect(send(messages(), { courseSlug: 'no-such-course' })).rejects.toMatchObject({ code: 'academy.course_not_found' });
    await expect(send(messages(null))).rejects.toMatchObject({ code: 'academy.message_limit_unset' });
    await expect(send(messages(5))).rejects.toMatchObject({ code: 'academy.message_too_long' });
    await expect(
      messages(null).staffReply({ conversationId: STAFF, body: 'x', clientRequestId: 'r', operatorId: STAFF, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.conversation_not_found' });
    expect(await sql`SELECT count(*)::int AS n FROM academy.course_conversations`).toEqual([{ n: 0 }]);
    const sent = await send(messages());
    await expect(messages().open({ userId: PEER, conversationId: sent.conversationId, limit: 50, now: NOW })).rejects.toMatchObject({
      code: 'academy.conversation_not_found',
    });
    expect(await messages().inbox(PEER, 10)).toEqual([]);
  });
});
