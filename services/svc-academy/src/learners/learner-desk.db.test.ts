/**
 * J-academy-14: the staff desk for one learner, against a real database. Figures are TEST values, not owner settings.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from '../academy-service.js';
import { createAcademyRouter } from '../router.js';
import { NullStreamProvider } from '../stream/provider.js';

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
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const STAFF = '33333333-3333-4333-8333-333333333333';
const PATH = 'sovereign';
const EDGE_SECRET = 'an-academy-learner-desk-test-edge-secret';
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-academy' });

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

function service(): AcademyService {
  return new AcademyService(
    db.sql,
    {
      async stakeOf() {
        return 0n;
      },
    },
    {
      async perksOf() {
        throw new Error('host rights unused');
      },
    },
    new NullStreamProvider(),
    { tournamentEnabled: false, paperTradingEnabled: false },
  );
}

function caller(academy: AcademyService, userId: string, scopes: string[]) {
  const principal = {
    sub: userId,
    userId,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  const ctx = edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-learner-desk',
  });
  return createAcademyRouter(academy).createCaller(ctx);
}

const QUIZ = {
  passMark: 1,
  attemptLimit: 1,
  timeLimitSeconds: null,
  reviewMode: 'score_only' as const,
  questions: [
    {
      id: 'q1',
      prompt: 'TEST?',
      points: 1,
      choices: [
        { id: 'a', text: 'TEST a' },
        { id: 'b', text: 'TEST b' },
      ],
      correctChoiceId: 'a',
    },
  ],
};

async function items(academy: AcademyService) {
  const list = (await academy.learners.progress(USER, true)).courses;
  return list;
}

describe('access records', () => {
  it('an ended record refuses the course’s items, writes its expiry once, and is reinstated on the same row', async () => {
    const academy = service();
    await academy.enrolCourse({ userId: USER, slug: PATH, track: 'audit' });
    const slug = (await items(academy))[0]!.items[0]!.slug;
    const t0 = new Date();
    await academy.learners.grantAccess({
      userId: USER,
      pathSlug: PATH,
      reason: 'TEST',
      expiresAt: new Date(t0.getTime() + 1000),
      actorId: STAFF,
      now: t0,
    });
    // A repeat of the first grant is the same record.
    await academy.learners.grantAccess({ userId: USER, pathSlug: PATH, reason: 'TEST again', expiresAt: null, actorId: STAFF, now: t0 });
    await expect(academy.readCurriculumItem({ userId: USER, slug, now: t0 })).resolves.toBeTruthy();
    const later = new Date(t0.getTime() + 5000);
    await expect(academy.readCurriculumItem({ userId: USER, slug, now: later })).rejects.toMatchObject({ code: 'academy.grant_expired' });
    await expect(academy.readCurriculumItem({ userId: USER, slug, now: later })).rejects.toMatchObject({ code: 'academy.grant_expired' });
    await expect(academy.markCurriculumComplete({ userId: USER, itemSlug: slug, now: later })).rejects.toMatchObject({
      code: 'academy.grant_expired',
    });
    await expect(academy.startQuizAttempt({ userId: USER, slug, now: later })).rejects.toMatchObject({ code: 'academy.grant_expired' });
    // Granting again on an ended record refuses: it is reinstated on its own row instead.
    await expect(
      academy.learners.grantAccess({ userId: USER, pathSlug: PATH, reason: 'TEST', expiresAt: null, actorId: STAFF, now: later }),
    ).rejects.toMatchObject({ code: 'academy.grant_expired' });
    const ended = (await academy.learners.page(USER, true, later)).access.filter((g) => g.pathSlug === PATH);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ state: 'expired', reason: 'TEST' });
    expect(ended[0]!.events.map((e) => e.kind)).toEqual(['granted', 'expired']);
    expect(ended[0]!.events[1]!.actorId).toBeNull();

    // A reinstatement names the event it becomes; a stale number refuses and changes nothing; blank reasons refuse.
    const grantId = ended[0]!.id!;
    await expect(
      academy.learners.reinstate({ userId: USER, grantId, reason: ' ', expiresAt: null, n: 3, actorId: STAFF }),
    ).rejects.toMatchObject({
      code: 'academy.reason_required',
    });
    await expect(
      academy.learners.reinstate({ userId: USER, grantId, reason: 'TEST', expiresAt: null, n: 2, actorId: STAFF }),
    ).rejects.toMatchObject({
      code: 'academy.revision_stale',
    });
    await expect(
      academy.learners.reinstate({ userId: OTHER, grantId, reason: 'TEST', expiresAt: null, n: 3, actorId: STAFF }),
    ).rejects.toMatchObject({ code: 'academy.grant_not_found' });
    await academy.learners.reinstate({ userId: USER, grantId, reason: 'TEST back', expiresAt: null, n: 3, actorId: STAFF });
    // A replay of the same reinstatement answers and writes nothing; one more on the live record refuses.
    await academy.learners.reinstate({ userId: USER, grantId, reason: 'TEST back', expiresAt: null, n: 3, actorId: STAFF });
    await expect(
      academy.learners.reinstate({ userId: USER, grantId, reason: 'TEST', expiresAt: null, n: 4, actorId: STAFF }),
    ).rejects.toMatchObject({
      code: 'academy.grant_active',
    });
    const back = (await academy.learners.page(USER, true)).access.filter((g) => g.pathSlug === PATH);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: grantId, state: 'granted', expiresAt: null });
    expect(back[0]!.events.map((e) => e.kind)).toEqual(['granted', 'expired', 'reinstated']);
    await expect(academy.readCurriculumItem({ userId: USER, slug })).resolves.toBeTruthy();
  });

  it('a learner with no record keeps the free enrolment as access, and a staff grant without a reason refuses', async () => {
    const academy = service();
    await academy.enrolCourse({ userId: USER, slug: PATH, track: 'audit' });
    const page = await academy.learners.page(USER, true);
    expect(page.access).toEqual([expect.objectContaining({ id: null, pathSlug: PATH, source: 'free', state: 'granted', expiresAt: null })]);
    await expect(
      academy.learners.grantAccess({ userId: USER, pathSlug: PATH, reason: '', expiresAt: null, actorId: STAFF }),
    ).rejects.toMatchObject({ code: 'academy.reason_required' });
    await expect(
      academy.learners.grantAccess({
        userId: USER,
        pathSlug: PATH,
        reason: 'TEST',
        expiresAt: new Date(Date.now() - 1000),
        actorId: STAFF,
      }),
    ).rejects.toMatchObject({ code: 'academy.window_invalid' });
    expect((await academy.learners.page(USER, true)).access[0]!.id).toBeNull();
  });
});

describe('progress and overrides', () => {
  it('shows an undone item’s tombstone, marks an item complete only with a reason, once per key', async () => {
    const academy = service();
    await academy.enrolCourse({ userId: USER, slug: PATH, track: 'audit' });
    const [first, second] = (await items(academy))[0]!.items;
    const done = await academy.markCurriculumComplete({ userId: USER, itemSlug: first!.slug });
    await academy.undoCurriculumComplete({
      userId: USER,
      itemSlug: first!.slug,
      completedAt: done.completedAt.toISOString(),
      clientRequestId: 'TEST-undo',
    });
    const row = (await items(academy))[0]!.items[0]!;
    expect(row.status).toBe('undone');
    expect(row.history.map((h) => h.event)).toEqual(['completed', 'undone']);

    const key = `override:${USER}:${second!.slug}:1`;
    await expect(
      academy.staffMarkComplete({ userId: USER, itemSlug: second!.slug, reason: '  ', key, operatorId: STAFF }),
    ).rejects.toMatchObject({ code: 'academy.reason_required' });
    expect((await items(academy))[0]!.items[1]!.status).toBe('not_started');
    await academy.staffMarkComplete({ userId: USER, itemSlug: second!.slug, reason: 'TEST offline', key, operatorId: STAFF });
    await academy.staffMarkComplete({ userId: USER, itemSlug: second!.slug, reason: 'TEST offline', key, operatorId: STAFF });
    expect((await items(academy))[0]!.items[1]!.status).toBe('completed');
    const audit = (await academy.learners.page(USER, true)).audit.filter((a) => a.kind === 'marked_complete');
    expect(audit).toEqual([expect.objectContaining({ actorId: STAFF, reason: 'TEST offline' })]);
  });

  it('a voided attempt stops counting against the limit, so exactly one retake is allowed', async () => {
    const academy = service();
    await academy.enrolCourse({ userId: USER, slug: PATH, track: 'audit' });
    const slug = (await items(academy))[0]!.items[1]!.slug;
    await academy.setQuiz({ slug, quiz: QUIZ, reason: 'TEST quiz', operatorId: STAFF });
    const first = await academy.startQuizAttempt({ userId: USER, slug });
    await academy.finishQuizAttempt({ userId: USER, attemptId: first.attemptId });
    await expect(academy.startQuizAttempt({ userId: USER, slug })).rejects.toMatchObject({ code: 'academy.attempt_limit' });
    const quiz = (await items(academy))[0]!.items[1]!.quiz!;
    expect(quiz).toMatchObject({ attemptLimit: 1, counted: 1 });
    const attemptId = quiz.attempts[0]!.attemptId;
    await expect(academy.learners.voidAttempt({ userId: USER, attemptId, reason: '', actorId: STAFF })).rejects.toMatchObject({
      code: 'academy.reason_required',
    });
    await expect(academy.learners.voidAttempt({ userId: OTHER, attemptId, reason: 'TEST', actorId: STAFF })).rejects.toMatchObject({
      code: 'academy.attempt_not_found',
    });
    await academy.learners.voidAttempt({ userId: USER, attemptId, reason: 'TEST page failed', actorId: STAFF });
    const voided = (await items(academy))[0]!.items[1]!.quiz!;
    expect(voided.counted).toBe(0);
    expect(voided.attempts[0]!.voided).toMatchObject({ by: STAFF, reason: 'TEST page failed' });
    const retake = await academy.startQuizAttempt({ userId: USER, slug });
    expect(retake.number).toBe(2);
    await academy.finishQuizAttempt({ userId: USER, attemptId: retake.attemptId });
    await expect(academy.startQuizAttempt({ userId: USER, slug })).rejects.toMatchObject({ code: 'academy.attempt_limit' });
  });
});

describe('notes, tags and permissions', () => {
  it('a note is kept for staff and never returned to the learner; a replay keeps one note', async () => {
    const academy = service();
    await academy.enrolCourse({ userId: USER, slug: PATH, track: 'audit' });
    const body = 'TEST internal: learner is upset about the outage';
    await academy.learners.addNote({ userId: USER, body, key: 'note:1', actorId: STAFF });
    await academy.learners.addNote({ userId: USER, body, key: 'note:1', actorId: STAFF });
    // Another note under the same key (a second agent on a stale page) refuses rather than vanishing.
    await expect(academy.learners.addNote({ userId: USER, body: 'TEST another', key: 'note:1', actorId: STAFF })).rejects.toMatchObject({
      code: 'academy.revision_stale',
    });
    expect((await academy.learners.page(USER, true)).notes).toEqual([expect.objectContaining({ n: 1, body, authorId: STAFF })]);
    const learner = caller(academy, USER, ['academy:read', 'academy:write']);
    const reads = await Promise.all([learner.myLearning(), learner.myAccessGrants(), learner.myProgress(), learner.myEnrollments()]);
    expect(JSON.stringify(reads)).not.toContain(body);
    await expect(learner.admin.learner({ userId: USER })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a report filtered by a tag lists only tagged learners', async () => {
    const academy = service();
    for (const userId of [USER, OTHER]) await academy.enrolCourse({ userId, slug: PATH, track: 'audit' });
    await expect(academy.learners.tag({ userIds: [USER], tag: 'test-tag', reason: ' ', actorId: STAFF })).rejects.toMatchObject({
      code: 'academy.reason_required',
    });
    expect(await academy.learners.tag({ userIds: [USER, USER], tag: 'test-tag', reason: 'TEST', actorId: STAFF })).toEqual({ added: 1 });
    expect((await academy.learners.learners({ tag: 'test-tag', limit: 50 })).rows.map((r) => r.userId)).toEqual([USER]);
    expect((await academy.learners.learners({ limit: 50 })).rows.map((r) => r.userId).sort()).toEqual([USER, OTHER].sort());
    expect(await academy.learners.tags()).toEqual([{ tag: 'test-tag', learners: 1 }]);
    await academy.learners.untag({ userId: USER, tag: 'test-tag', reason: 'TEST', actorId: STAFF });
    expect((await academy.learners.learners({ tag: 'test-tag', limit: 50 })).rows).toEqual([]);
    const kinds = (await academy.learners.page(USER, true)).audit.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['tag_added', 'tag_removed']));
  });

  it('a read-only session reads the page with no change allowed, and a direct change refuses as not permitted', async () => {
    const academy = service();
    await academy.enrolCourse({ userId: USER, slug: PATH, track: 'audit' });
    const reader = caller(academy, STAFF, ['admin:read']);
    expect((await reader.admin.learner({ userId: USER })).canChange).toBe(false);
    expect((await reader.admin.learnerProgress({ userId: USER })).canChange).toBe(false);
    const slug = (await items(academy))[0]!.items[0]!.slug;
    await expect(reader.admin.markCompleteFor({ userId: USER, itemSlug: slug, reason: 'TEST', key: 'override:x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('academy.permission_denied'),
    });
    await expect(reader.admin.addLearnerNote({ userId: USER, body: 'TEST', key: 'k' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reader.admin.tagLearners({ userIds: [USER], tag: 'x', reason: 'TEST' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await academy.learners.page(USER, true)).audit).toEqual([]);
    const writer = caller(academy, STAFF, ['admin:read', 'admin:write']);
    expect((await writer.admin.learner({ userId: USER })).canChange).toBe(true);
    await writer.admin.markCompleteFor({ userId: USER, itemSlug: slug, reason: 'TEST', key: 'override:y' });
    expect((await items(academy))[0]!.items[0]!.status).toBe('completed');
  });
});
