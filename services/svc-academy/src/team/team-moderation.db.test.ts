/**
 * J-academy-18 against Postgres: course team roles (AC-roles-01) and discussion moderation (AC-rooms-02).
 *
 * Roles narrow a founder only where they hold one; a role change waits for a second founder; nobody gives a role above
 * their own; a switched-off custom role permits nothing; a blank custom role limit refuses by name. A report is one per
 * account; the queue lists reported posts still showing; a read-only session deletes nothing; a delete needs a reason and a
 * moderator's role, leaves learner reads, keeps the row, and waits in the outbox until the bus took the author's notice;
 * bulk delete takes one course's posts and no other course's.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from '../curriculum/courses.js';
import { CourseDiscussion } from '../curriculum/discussion.js';
import { DiscussionModeration, type ModerationNotice } from '../curriculum/moderation.js';
import { CourseTeam } from './course-team.js';

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
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUPPORT = '33333333-3333-4333-8333-333333333333';
const AUTHOR = '55555555-5555-4555-8555-555555555555';
const PEER = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-11-12T12:00:00.000Z');
const founder = (userId: string) => ({ userId, mayWrite: true });
const readOnly = { userId: SUPPORT, mayWrite: false };

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

async function course(slug: string) {
  const records = new CourseRecords(sql, { maxSections: 5, maxItems: 5 });
  const made = await records.create({
    slug,
    title: `TEST ${slug}`,
    summary: null,
    thumbnailUrl: null,
    pricing: 'free',
    price: null,
    priceAsset: null,
    operatorId: A,
    now: NOW,
  });
  const detail = await records.saveOutline({
    courseId: made.id,
    revision: 1,
    sections: [{ title: 'Start', items: [{ kind: 'lesson', title: 'One', indent: 0, url: null }] }],
    operatorId: A,
    now: NOW,
  });
  await records.setState({ courseId: made.id, to: 'published', revision: detail.course.revision, reason: 'TEST', operatorId: A, now: NOW });
  for (const user of [AUTHOR, PEER])
    await sql`INSERT INTO academy.course_enrolments (course_id, user_id, track, enrolled_at) VALUES (${made.id}, ${user}, 'audit', ${NOW})`;
  return made;
}

const discussion = new CourseDiscussion(sql, { postMaxChars: 1000, imageMaxBytes: null });
let n = 0;
const post = (slug: string, userId = AUTHOR) =>
  discussion.createPost({
    courseSlug: slug,
    topicSlug: 'general',
    kind: 'discussion',
    title: `TEST post ${++n}`,
    body: 'TEST body',
    anonymous: false,
    image: null,
    clientRequestId: `req-${n}`,
    userId,
    now: NOW,
  });

/** A team where founder A gives founder B `role` on the course and founder B confirms it. */
async function give(team: CourseTeam, courseId: string | null, role: string) {
  const change = await team.propose({
    courseId,
    accountId: B,
    role,
    kind: 'assign',
    reason: 'TEST',
    requestId: `r-${role}-${courseId}`,
    caller: founder(A),
    now: NOW,
  });
  return team.confirm({ changeId: change.id, caller: founder(B), now: NOW });
}

describe('course team roles (AC-roles-01)', () => {
  it('a role change waits for a second founder, and the proposer cannot confirm it', async () => {
    const team = new CourseTeam(sql, 5);
    const c = await course('team-a');
    const change = await team.propose({
      courseId: c.id,
      accountId: B,
      role: 'moderator',
      kind: 'assign',
      reason: 'TEST',
      requestId: 'r1',
      caller: founder(A),
      now: NOW,
    });
    expect(change.state).toBe('pending');
    expect((await team.permissionsOf(B, c.id)).narrowed).toBe(false);
    await expect(team.confirm({ changeId: change.id, caller: founder(A), now: NOW })).rejects.toMatchObject({
      code: 'academy.second_founder_required',
    });
    // A retry of the same proposal is the same change.
    const again = await team.propose({
      courseId: c.id,
      accountId: B,
      role: 'moderator',
      kind: 'assign',
      reason: 'TEST',
      requestId: 'r1',
      caller: founder(A),
      now: NOW,
    });
    expect(again.id).toBe(change.id);
    const done = await team.confirm({ changeId: change.id, caller: founder(B), now: NOW });
    expect(done).toMatchObject({ state: 'confirmed', confirmedBy: B });
    expect(await team.permissionsOf(B, c.id)).toEqual({ narrowed: true, permissions: ['discussion.moderate', 'discussion.endorse'] });
    // Only on that course: elsewhere B keeps the founder's reach.
    const other = await course('team-b');
    expect((await team.permissionsOf(B, other.id)).narrowed).toBe(false);
  });

  it('a moderator cannot give the admin role (escalation), nor any role without the right to assign', async () => {
    const team = new CourseTeam(sql, 5);
    const c = await course('team-c');
    await give(team, c.id, 'moderator');
    await expect(
      team.propose({
        courseId: c.id,
        accountId: PEER,
        role: 'admin',
        kind: 'assign',
        reason: 'TEST',
        requestId: 'r2',
        caller: founder(B),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.role_escalation' });
    await expect(
      team.propose({
        courseId: c.id,
        accountId: PEER,
        role: 'community_ta',
        kind: 'assign',
        reason: 'TEST',
        requestId: 'r3',
        caller: founder(B),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.permission_denied' });
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM academy.team_changes WHERE proposed_by = ${B}`;
    expect(count!.n).toBe(0);
  });

  it('limited staff cannot edit content and can read reports', async () => {
    const team = new CourseTeam(sql, 5);
    const c = await course('team-d');
    await give(team, c.id, 'limited_staff');
    await expect(team.require(B, c.id, 'content.edit')).rejects.toMatchObject({ code: 'academy.permission_denied' });
    await expect(team.require(B, c.id, 'reports')).resolves.toBeUndefined();
  });

  it('a blank custom role limit refuses by name; with it set the role saves, and switched off it permits nothing', async () => {
    const c = await course('team-e');
    const input = {
      name: 'test_reviewer',
      permissions: ['reports', 'comments'] as ('reports' | 'comments')[],
      reason: 'TEST',
      requestId: 'cr1',
      caller: founder(A),
      now: NOW,
    };
    await expect(new CourseTeam(sql, null).saveCustomRole(input)).rejects.toMatchObject({ code: 'academy.role_limit_unset' });
    const team = new CourseTeam(sql, 1);
    const role = await team.saveCustomRole(input);
    expect(role).toMatchObject({ kind: 'custom', active: true, permissions: ['reports', 'comments'] });
    expect((await team.saveCustomRole(input)).ref).toBe(role.ref);
    await expect(team.saveCustomRole({ ...input, name: 'test_other', requestId: 'cr2' })).rejects.toMatchObject({
      code: 'academy.role_limit_reached',
    });
    await give(team, c.id, role.ref);
    expect((await team.permissionsOf(B, c.id)).permissions).toEqual(['reports', 'comments']);
    const off = await team.setCustomRoleActive({ roleId: role.ref.slice(7), active: false, reason: 'TEST', caller: founder(A), now: NOW });
    expect(off).toMatchObject({ active: false, holders: 1 });
    expect(await team.permissionsOf(B, c.id)).toEqual({ narrowed: true, permissions: [] });
    await expect(
      team.setCustomRoleActive({ roleId: role.ref.slice(7), active: true, reason: ' ', caller: founder(A), now: NOW }),
    ).rejects.toMatchObject({
      code: 'academy.reason_required',
    });
  });
});

describe('discussion moderation (AC-rooms-02)', () => {
  const setup = async (notices: ModerationNotice[] | null, fail = false) => {
    const team = new CourseTeam(sql, 5);
    const publisher =
      notices === null
        ? null
        : {
            publish: async (notice: ModerationNotice) => {
              if (fail) throw new Error('TEST bus down');
              notices.push(notice);
            },
          };
    return { team, moderation: new DiscussionModeration(sql, team, publisher) };
  };

  it('a report is one per account, the queue lists it, and a read-only session deletes nothing', async () => {
    const { moderation } = await setup([]);
    await course('mod-a');
    const p = await post('mod-a');
    expect(await moderation.report({ userId: PEER, postId: p.id, reason: 'TEST spam', now: NOW })).toEqual({
      postId: p.id,
      reported: true,
    });
    expect(await moderation.report({ userId: PEER, postId: p.id, reason: 'TEST again', now: NOW })).toEqual({
      postId: p.id,
      reported: false,
    });
    await expect(moderation.report({ userId: SUPPORT, postId: p.id, reason: 'TEST', now: NOW })).rejects.toMatchObject({
      code: 'academy.enrolment_required',
    });
    const queue = await moderation.queue({ courseId: null, limit: 50, caller: readOnly });
    expect(queue.mayWrite).toBe(false);
    expect(queue.reports).toHaveLength(1);
    expect(queue.reports[0]).toMatchObject({ postId: p.id, reports: 1, reasons: ['TEST spam'], authorId: AUTHOR, mayModerate: false });
    await expect(moderation.deletePost({ postId: p.id, reason: 'TEST', caller: readOnly, now: NOW })).rejects.toMatchObject({
      code: 'academy.permission_denied',
    });
  });

  it('a delete needs a reason and a moderator role; it leaves learner reads, keeps the row and tells the author once', async () => {
    const notices: ModerationNotice[] = [];
    const { team, moderation } = await setup(notices);
    const c = await course('mod-b');
    const p = await post('mod-b');
    const reply = await discussion.reply({
      postId: p.id,
      body: 'TEST reply',
      anonymous: false,
      clientRequestId: 'reply-1',
      userId: PEER,
      now: NOW,
    });
    await moderation.report({ userId: PEER, postId: p.id, reason: 'TEST spam', now: NOW });
    await expect(moderation.deletePost({ postId: p.id, reason: '  ', caller: founder(A), now: NOW })).rejects.toMatchObject({
      code: 'academy.reason_required',
    });
    // Limited staff on the course may not moderate.
    await give(team, c.id, 'limited_staff');
    await expect(moderation.deletePost({ postId: p.id, reason: 'TEST', caller: founder(B), now: NOW })).rejects.toMatchObject({
      code: 'academy.permission_denied',
    });
    const event = await moderation.deletePost({ postId: p.id, reason: 'TEST off-topic', caller: founder(A), now: NOW });
    expect(event).toMatchObject({ action: 'delete', postId: p.id, authorId: AUTHOR, posts: 1, actorId: A, reason: 'TEST off-topic' });
    expect(notices).toEqual([{ eventId: event.id, authorId: AUTHOR, courseTitle: 'TEST mod-b', posts: 1, reason: 'TEST off-topic' }]);
    // A repeat answers with the same event and tells nobody again.
    expect((await moderation.deletePost({ postId: p.id, reason: 'TEST off-topic', caller: founder(A), now: NOW })).id).toBe(event.id);
    expect(notices).toHaveLength(1);
    // Gone from learners, the reply with it; the queue has no open report; the row is kept with who and why.
    expect(await discussion.posts({ userId: PEER, courseSlug: 'mod-b', topicSlug: 'general', limit: 50 })).toEqual([]);
    await expect(discussion.thread({ userId: PEER, postId: p.id, limit: 50 })).rejects.toMatchObject({ code: 'academy.post_not_found' });
    await expect(discussion.like({ userId: PEER, postId: reply.id, on: true, now: NOW })).rejects.toMatchObject({
      code: 'academy.post_not_found',
    });
    expect((await moderation.queue({ courseId: c.id, limit: 50, caller: founder(A) })).reports).toEqual([]);
    const [row] = await sql`SELECT removed_by, removed_reason FROM academy.discussion_posts WHERE id = ${p.id}`;
    expect(row).toEqual({ removed_by: A, removed_reason: 'TEST off-topic' });
  });

  it('with the bus down the notice waits in the outbox and goes on the next send', async () => {
    const notices: ModerationNotice[] = [];
    const down = await setup(notices, true);
    await course('mod-c');
    const p = await post('mod-c');
    const event = await down.moderation.deletePost({ postId: p.id, reason: 'TEST', caller: founder(A), now: NOW });
    const [waiting] = await sql`SELECT notified_at FROM academy.moderation_events WHERE id = ${event.id}`;
    expect(waiting!.notified_at).toBeNull();
    const up = await setup(notices);
    expect(await up.moderation.sendWaiting()).toBe(1);
    expect(notices.map((x) => x.eventId)).toEqual([event.id]);
    expect(await up.moderation.sendWaiting()).toBe(0);
  });

  it("bulk delete takes one author's posts in one course and none elsewhere", async () => {
    const notices: ModerationNotice[] = [];
    const { moderation } = await setup(notices);
    const x = await course('mod-x');
    await course('mod-y');
    const [x1, x2] = [await post('mod-x'), await post('mod-x')];
    const peerPost = await post('mod-x', PEER);
    const y1 = await post('mod-y');
    const event = await moderation.bulkDelete({
      courseId: x.id,
      authorId: AUTHOR,
      reason: 'TEST spam account',
      caller: founder(A),
      now: NOW,
    });
    expect(event).toMatchObject({ action: 'bulk_delete', postId: null, posts: 2 });
    const inX = (await discussion.posts({ userId: PEER, courseSlug: 'mod-x', topicSlug: 'general', limit: 50 })).map((p) => p.id);
    expect(inX).toEqual([peerPost.id]);
    expect(inX).not.toContain(x1.id);
    expect(inX).not.toContain(x2.id);
    expect((await discussion.posts({ userId: PEER, courseSlug: 'mod-y', topicSlug: 'general', limit: 50 })).map((p) => p.id)).toEqual([
      y1.id,
    ]);
    expect(notices).toEqual([{ eventId: event.id, authorId: AUTHOR, courseTitle: 'TEST mod-x', posts: 2, reason: 'TEST spam account' }]);
    // Nothing left to delete: a second bulk delete is recorded with 0 posts and tells nobody.
    const none = await moderation.bulkDelete({ courseId: x.id, authorId: AUTHOR, reason: 'TEST again', caller: founder(A), now: NOW });
    expect(none.posts).toBe(0);
    expect(notices).toHaveLength(1);
  });
});
