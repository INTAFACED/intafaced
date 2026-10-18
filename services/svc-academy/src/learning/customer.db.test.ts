import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { AcademyService } from '../academy-service.js';
import { NullStreamProvider } from '../stream/provider.js';
import { createAcademyRouter } from '../router.js';
import { FOUNDATIONS_V1 } from '../certs/catalog.js';
import { listCurriculum } from '../curriculum/catalog.js';
import { formatUtcIcs } from './calendar.js';
import type { ProgrammeDefinition } from '../curriculum/programmes.js';
import type { VideoSpineEntry } from '../video/catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

/**
 * The shared test server's TEST_DATABASE_URL names database `test`.
 * createTestDatabase refuses any database whose name does not end in `_test`.
 * Same host, the existing `intafaced_test` database, when the env name is not already a test database.
 */
function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const ADMIN_URL = adminUrl();
const db: TestDatabase = await createTestDatabase({ service: 'academy', url: ADMIN_URL, migrations: MIGRATIONS });
const sql = db.sql;

const SECRET = 'academy-learning-backend-edge-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

function service(options: ConstructorParameters<typeof AcademyService>[4] = {}) {
  return new AcademyService(
    sql,
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
    { tournamentEnabled: false, paperTradingEnabled: false, ...options },
  );
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['academy:read', 'academy:write', 'admin:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req',
  });
}

const anonymous = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'anon' });

const WITH_PREREQ: ProgrammeDefinition[] = [
  { slug: 'foundations', prerequisites: [] },
  { slug: 'markets', prerequisites: ['foundations'] },
  { slug: 'builder', prerequisites: [] },
  { slug: 'sovereign', prerequisites: [] },
];

/** TEST certificates so the prerequisite case can enrol a path. Not owner content. */
const TEST_MARKETS_CERT = {
  id: 'test-markets-v1',
  title: 'TEST Markets',
  path: 'markets' as const,
  requiredItemSlugs: ['markets-reading-the-book'],
};
const TEST_BUILDER_CERT = {
  id: 'test-builder-v1',
  title: 'TEST Builder',
  path: 'builder' as const,
  requiredItemSlugs: ['builder-first-automation'],
};

const TIMED_VIDEO: VideoSpineEntry = {
  slug: 'foundations-risk-first',
  title: 'Risk first',
  path: 'foundations',
  objectKey: 'foundations/risk-first.mp4',
  durationSeconds: 30,
  thumbnailUrl: null,
  language: null,
  captionsUrl: null,
};

describe('academy customer learning reads and writes', () => {
  it('lists the caller completions, including a lesson outside every certificate, and pages', async () => {
    expect(FOUNDATIONS_V1.requiredItemSlugs).not.toContain('markets-reading-the-book');
    const academy = service();
    await academy.markCurriculumComplete({ userId: USER, itemSlug: 'markets-reading-the-book' });
    await academy.markCurriculumComplete({ userId: OTHER, itemSlug: 'foundations-risk-first' });
    const mine = await academy.myCompletions({ userId: USER, limit: 10 });
    expect(mine.items.map((row) => row.itemSlug)).toEqual(['markets-reading-the-book']);
    const theirs = await academy.myCompletions({ userId: OTHER, limit: 10 });
    expect(theirs.items.map((row) => row.itemSlug)).toEqual(['foundations-risk-first']);

    await sql`
      INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES
        (${USER}, 'page-a', '2026-10-01T00:00:00Z'),
        (${USER}, 'page-b', '2026-10-02T00:00:00Z'),
        (${USER}, 'page-c', '2026-10-03T00:00:00Z')
    `;
    const first = await academy.myCompletions({ userId: USER, limit: 2 });
    const second = await academy.myCompletions({ userId: USER, limit: 2, cursor: first.nextCursor });
    const slugs = [...first.items, ...second.items].map((row) => row.itemSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toEqual(['markets-reading-the-book', 'page-c', 'page-b', 'page-a']);
    expect(second.nextCursor).toBeNull();

    const caller = createAcademyRouter(academy).createCaller(anonymous());
    await expect(caller.myCompletions({ limit: 10 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('enrols, lists, leaves with history, and replays the leave', async () => {
    const academy = service();
    await academy.enrollCertPath({ userId: USER, pathSlug: 'foundations' });
    expect((await academy.myEnrollments(USER)).map((row) => row.pathSlug)).toEqual(['foundations']);
    const left = await academy.leaveCertPath({ userId: USER, pathSlug: 'foundations', clientRequestId: 'leave-1' });
    expect(left.leftAt).toBeInstanceOf(Date);
    expect(await academy.myEnrollments(USER)).toEqual([]);
    const history = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM academy.cert_enrollments
       WHERE user_id = ${USER} AND path_slug = 'foundations' AND left_at IS NOT NULL
    `;
    expect(history[0]?.n).toBe(1);
    await expect(academy.leaveCertPath({ userId: OTHER, pathSlug: 'foundations', clientRequestId: 'leave-other' })).rejects.toMatchObject({
      code: 'academy.enrollment_not_found',
    });
    const still = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM academy.cert_enrollments
       WHERE user_id = ${USER} AND path_slug = 'foundations' AND left_at IS NOT NULL
    `;
    expect(still[0]?.n).toBe(1);
    const replay = await academy.leaveCertPath({ userId: USER, pathSlug: 'foundations', clientRequestId: 'leave-1' });
    expect(replay.leftAt?.toISOString()).toBe(left.leftAt?.toISOString());
    expect(replay.enrolledAt.toISOString()).toBe(left.enrolledAt.toISOString());
    await academy.enrollCertPath({ userId: USER, pathSlug: 'foundations' });
    const rows = await sql<Array<{ n: number; active: number }>>`
      SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE left_at IS NULL)::int AS active
        FROM academy.cert_enrollments WHERE user_id = ${USER} AND path_slug = 'foundations'
    `;
    expect(rows[0]).toEqual({ n: 2, active: 1 });
  });

  it('refuses an unmet programme prerequisite and enrols when it is met or empty', async () => {
    const gated = service({ programmeCatalog: WITH_PREREQ, certCatalog: [FOUNDATIONS_V1, TEST_MARKETS_CERT] });
    await expect(gated.enrollCertPath({ userId: USER, pathSlug: 'markets' })).rejects.toMatchObject({
      code: 'academy.prerequisite_unmet',
      message: expect.stringContaining('foundations'),
    });
    const none = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM academy.cert_enrollments WHERE user_id = ${USER}
    `;
    expect(none[0]?.n).toBe(0);
    await gated.enrollCertPath({ userId: USER, pathSlug: 'foundations' });
    await gated.enrollCertPath({ userId: USER, pathSlug: 'markets' });
    expect((await gated.myEnrollments(USER)).map((row) => row.pathSlug).sort()).toEqual(['foundations', 'markets']);
    const open = service({ certCatalog: [FOUNDATIONS_V1, TEST_BUILDER_CERT] });
    await open.enrollCertPath({ userId: OTHER, pathSlug: 'builder' });
    expect((await open.myEnrollments(OTHER)).map((row) => row.pathSlug)).toEqual(['builder']);
  });

  it('records resume, seconds and UTC active days once per client request', async () => {
    const academy = service();
    const day1 = await academy.touchLesson({
      userId: USER,
      slug: 'markets-reading-the-book',
      secondsRead: 10,
      clientRequestId: 'touch-1',
      now: new Date('2026-10-17T23:00:00Z'),
    });
    const again = await academy.touchLesson({
      userId: USER,
      slug: 'markets-reading-the-book',
      secondsRead: 15,
      clientRequestId: 'touch-2',
      now: new Date('2026-10-17T23:30:00Z'),
    });
    expect(again.activeDays).toBe(1);
    expect(again.secondsRead).toBe(25);
    const day2 = await academy.touchLesson({
      userId: USER,
      slug: 'foundations-risk-first',
      secondsRead: 5,
      clientRequestId: 'touch-3',
      now: new Date('2026-10-18T00:30:00Z'),
    });
    expect(day2.activeDays).toBe(2);
    expect(day2.lastItemSlug).toBe('foundations-risk-first');
    const replay = await academy.touchLesson({
      userId: USER,
      slug: 'markets-reading-the-book',
      secondsRead: 10,
      clientRequestId: 'touch-1',
      now: new Date('2026-10-19T00:00:00Z'),
    });
    expect(replay.secondsRead).toBe(day1.secondsRead);
    expect(replay.activeDays).toBe(1);
    expect((await academy.learningState(USER)).secondsRead).toBe(30);
    expect(await academy.learningState(OTHER)).toEqual({
      lastItemSlug: null,
      lastOpenedAt: null,
      secondsRead: 0,
      activeDays: 0,
    });
    await expect(
      academy.touchLesson({ userId: USER, slug: 'no-such-lesson', secondsRead: 1, clientRequestId: 'touch-x' }),
    ).rejects.toMatchObject({ code: 'academy.curriculum_not_found' });
    await expect(
      academy.touchLesson({ userId: USER, slug: 'markets-reading-the-book', secondsRead: 86_401, clientRequestId: 'touch-y' }),
    ).rejects.toMatchObject({ code: 'academy.seconds_out_of_range' });
  });

  it('lists open published cohorts and computes seats only from a set capacity', async () => {
    await sql`
      INSERT INTO academy.residency_cohorts (slug, status, published, starts_at, ends_at, capacity, entry_rules) VALUES
        ('open-set', 'open', true, '2026-11-01T00:00:00Z', '2026-11-08T00:00:00Z', 2, 'statement required'),
        ('open-unset', 'open', true, NULL, NULL, NULL, NULL),
        ('closed-one', 'closed', true, '2026-11-01T00:00:00Z', NULL, 4, 'closed'),
        ('draft-one', 'open', false, '2026-11-01T00:00:00Z', NULL, 4, 'draft')
    `;
    const academy = service();
    const before = await academy.residencyCohorts(10);
    expect(before.map((row) => row.slug).sort()).toEqual(['open-set', 'open-unset']);
    const unset = before.find((row) => row.slug === 'open-unset');
    expect(unset?.capacity).toBeNull();
    expect(unset?.seatsLeft).toBeNull();
    expect(unset?.startsAt).toBeNull();
    expect(unset?.entryRules).toBeNull();
    await sql`
      INSERT INTO academy.residency_applications (user_id, cohort_slug, statement, status)
      VALUES (${OTHER}, 'open-set', 'I want a seat in this cohort.', 'applied')
    `;
    const after = await academy.residencyCohorts(10);
    expect(after.find((row) => row.slug === 'open-set')?.seatsLeft).toBe(1);
    expect(JSON.stringify(after)).not.toContain(OTHER);
  });

  it('stores watch position for the caller and refuses a position past a set duration', async () => {
    const academy = service();
    const set = await academy.setVideoProgress({
      userId: USER,
      videoSlug: 'foundations-risk-first',
      positionSeconds: 12,
      clientRequestId: 'watch-1',
    });
    expect(await academy.getVideoProgress({ userId: USER, videoSlug: 'foundations-risk-first' })).toEqual({
      videoSlug: 'foundations-risk-first',
      positionSeconds: set.positionSeconds,
    });
    await academy.setVideoProgress({
      userId: USER,
      videoSlug: 'foundations-risk-first',
      positionSeconds: 12,
      clientRequestId: 'watch-1',
    });
    expect((await academy.getVideoProgress({ userId: USER, videoSlug: 'foundations-risk-first' })).positionSeconds).toBe(12);
    await academy.setVideoProgress({
      userId: USER,
      videoSlug: 'foundations-risk-first',
      positionSeconds: 20,
      clientRequestId: 'watch-2',
    });
    expect((await academy.getVideoProgress({ userId: USER, videoSlug: 'foundations-risk-first' })).positionSeconds).toBe(20);
    expect(await academy.getVideoProgress({ userId: OTHER, videoSlug: 'foundations-risk-first' })).toEqual({
      videoSlug: 'foundations-risk-first',
      positionSeconds: null,
    });

    const timed = service({ videoSpine: [TIMED_VIDEO] });
    await expect(
      timed.setVideoProgress({
        userId: USER,
        videoSlug: 'foundations-risk-first',
        positionSeconds: 31,
        clientRequestId: 'watch-over',
      }),
    ).rejects.toMatchObject({ code: 'academy.video_position_out_of_range' });
    expect((await academy.getVideoProgress({ userId: USER, videoSlug: 'foundations-risk-first' })).positionSeconds).toBe(20);
  });

  it('reports the caller seat, upcoming sessions, and a calendar only for that seat', async () => {
    const room = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const mine = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const theirs = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const starts = new Date('2026-12-01T15:30:00Z');
    await sql`
      INSERT INTO academy.rooms (id, slug, name, kind, access, min_stake, capacity, host_id)
      VALUES (${room}, 'desk', 'Desk', 'general', 'free', 0, 8, ${USER})
    `;
    await sql`
      INSERT INTO academy.sessions (id, room_id, title, host_id, status, starts_at) VALUES
        (${mine}, ${room}, 'My hour', ${USER}, 'scheduled', ${starts}),
        (${theirs}, ${room}, 'Their hour', ${OTHER}, 'scheduled', '2026-12-02T15:30:00Z')
    `;
    await sql`
      INSERT INTO academy.session_attendees (session_id, user_id, role) VALUES
        (${mine}, ${USER}, 'attendee'),
        (${theirs}, ${OTHER}, 'host')
    `;
    const academy = service();
    const caller = createAcademyRouter(academy).createCaller(signed(principal({ scopes: ['academy:read', 'academy:write'] })));
    const roomRead = await caller.room({ roomId: room, limit: 10 });
    expect(roomRead.room.seated).toBe(true);
    expect(roomRead.room.role).toBe('attendee');
    expect(roomRead.sessions.find((s) => s.id === mine)).toMatchObject({ seated: true, role: 'attendee' });
    expect(roomRead.sessions.find((s) => s.id === theirs)).toMatchObject({ seated: false, role: null });
    const sessionRead = await caller.session({ sessionId: theirs });
    expect(sessionRead.session.seated).toBe(false);
    expect(sessionRead.session.role).toBeNull();
    const upcoming = await caller.myUpcomingSessions({ limit: 10 });
    expect(upcoming.map((row) => row.id)).toEqual([mine]);
    const calendar = await caller.sessionCalendar({ sessionId: mine });
    expect(calendar.calendar).toContain('BEGIN:VCALENDAR');
    expect(calendar.calendar).toContain(`DTSTART:${formatUtcIcs(starts)}`);
    expect(calendar.calendar).toContain('X-WR-TIMEZONE:UTC');
    await expect(caller.sessionCalendar({ sessionId: theirs })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('gives operators grant audit and daily counts, and refuses a session without admin:read', async () => {
    await sql`
      INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES
        (${USER}, 'markets-reading-the-book', '2026-10-17T01:00:00Z'),
        (${OTHER}, 'foundations-risk-first', '2026-10-17T02:00:00Z')
    `;
    await sql`
      INSERT INTO academy.cert_grants (user_id, cert_id, granted_at, idempotency_key) VALUES
        (${USER}, 'foundations-v1', '2026-10-17T03:00:00Z', ${`cert:${USER}:foundations-v1`})
    `;
    await sql`
      INSERT INTO academy.learning_touches (
        user_id, client_request_id, item_slug, seconds_added, touched_at,
        last_item_slug, last_opened_at, seconds_read, active_days
      ) VALUES (
        ${USER}, 'op-touch', 'markets-reading-the-book', 4, '2026-10-17T04:00:00Z',
        'markets-reading-the-book', '2026-10-17T04:00:00Z', 4, 1
      )
    `;
    const academy = service();
    const operator = createAcademyRouter(academy).createCaller(signed());
    await sql`
      INSERT INTO academy.cert_grants (user_id, cert_id, granted_at, idempotency_key) VALUES
        (${OTHER}, 'foundations-v1', '2026-10-17T05:00:00Z', ${`cert:${OTHER}:foundations-v1`}),
        (${USER}, 'other-cert', '2026-10-16T03:00:00Z', ${`cert:${USER}:other-cert`})
    `;
    const audit = await operator.admin.grantAudit({ limit: 2 });
    const auditRest = await operator.admin.grantAudit({ limit: 2, cursor: audit.nextCursor ?? undefined });
    const auditIds = [...audit.items, ...auditRest.items].map((row) => `${row.accountId}:${row.certificateId}`);
    expect(new Set(auditIds).size).toBe(auditIds.length);
    expect(auditIds).toHaveLength(3);
    expect(audit.items[0]).toEqual({
      accountId: OTHER,
      certificateId: 'foundations-v1',
      grantedAt: new Date('2026-10-17T05:00:00Z'),
      status: 'granted',
      reference: `cert:${OTHER}:foundations-v1`,
    });
    const metrics = await operator.admin.opsMetrics({ from: '2026-10-17', to: '2026-10-18' });
    expect(metrics.days).toEqual([
      {
        date: '2026-10-17',
        lessonsRead: { value: 1, reason: null },
        completions: { value: 2, reason: null },
        grants: { value: 2, reason: null },
      },
      {
        date: '2026-10-18',
        lessonsRead: { value: 0, reason: null },
        completions: { value: 0, reason: null },
        grants: { value: 0, reason: null },
      },
    ]);
    const reader = createAcademyRouter(academy).createCaller(signed(principal({ scopes: ['academy:read', 'academy:write'] })));
    await expect(reader.admin.grantAudit({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reader.admin.opsMetrics({ from: '2026-10-17', to: '2026-10-17' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(operator.admin.opsMetrics({ from: '2026-10-18', to: '2026-10-17' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(operator.admin.opsMetrics({ from: '2026-02-31', to: '2026-03-01' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('counts enrolments by path inside the UTC window and hides account ids', async () => {
    const third = '44444444-4444-4444-8444-444444444444';
    await sql`
      INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at, left_at) VALUES
        (${USER}, 'foundations', '2026-10-17T00:00:00Z', NULL),
        (${OTHER}, 'foundations', '2026-10-17T12:00:00Z', '2026-10-17T18:00:00Z'),
        (${USER}, 'markets', '2026-10-18T23:59:59Z', NULL),
        (${OTHER}, 'builder', '2026-09-01T00:00:00Z', NULL),
        (${third}, 'sovereign', '2026-10-19T00:00:00Z', NULL)
    `;
    const academy = service();
    const operator = createAcademyRouter(academy).createCaller(signed());
    const counts = await operator.admin.enrolments({ from: '2026-10-17', to: '2026-10-18' });
    expect(counts).toEqual({
      from: '2026-10-17',
      to: '2026-10-18',
      total: 3,
      paths: [
        { pathSlug: 'foundations', count: 2 },
        { pathSlug: 'markets', count: 1 },
      ],
    });
    const empty = await operator.admin.enrolments({ from: '2020-01-01', to: '2020-01-02' });
    expect(empty).toEqual({ from: '2020-01-01', to: '2020-01-02', total: 0, paths: [] });
    const body = JSON.stringify({ counts, empty });
    expect(body).not.toContain(USER);
    expect(body).not.toContain(OTHER);
    expect(body).not.toContain(third);
    const reader = createAcademyRouter(academy).createCaller(signed(principal({ scopes: ['academy:read'] })));
    await expect(reader.admin.enrolments({ from: '2026-10-17', to: '2026-10-18' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(operator.admin.enrolments({ from: '2026-10-18', to: '2026-10-17' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(operator.admin.enrolments({ from: '2025-01-01', to: '2026-01-02' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('counts completions per catalogue item, applies the path filter, and refuses an unknown path', async () => {
    const third = '44444444-4444-4444-8444-444444444444';
    const fourth = '55555555-5555-4555-8555-555555555555';
    await sql`
      INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES
        (${USER}, 'foundations-risk-first', '2026-10-17T01:00:00Z'),
        (${OTHER}, 'foundations-risk-first', '2026-10-17T02:00:00Z'),
        (${third}, 'foundations-risk-first', '2026-10-18T03:00:00Z'),
        (${fourth}, 'foundations-risk-first', '2026-10-16T03:00:00Z'),
        (${USER}, 'markets-reading-the-book', '2026-10-17T04:00:00Z'),
        (${USER}, 'builder-first-automation', '2026-10-17T05:00:00Z'),
        (${OTHER}, 'builder-first-automation', '2026-10-18T06:00:00Z'),
        (${USER}, 'not-in-spine', '2026-10-17T07:00:00Z')
    `;
    const academy = service();
    const operator = createAcademyRouter(academy).createCaller(signed());
    const all = await operator.admin.completionsByItem({ from: '2026-10-17', to: '2026-10-18' });
    const bySlug = new Map(all.items.map((row) => [row.itemSlug, row]));
    expect(bySlug.get('foundations-risk-first')).toEqual({ itemSlug: 'foundations-risk-first', pathSlug: 'foundations', count: 3 });
    expect(bySlug.get('markets-reading-the-book')).toEqual({
      itemSlug: 'markets-reading-the-book',
      pathSlug: 'markets',
      count: 1,
    });
    expect(bySlug.get('builder-first-automation')).toEqual({
      itemSlug: 'builder-first-automation',
      pathSlug: 'builder',
      count: 2,
    });
    expect(bySlug.get('foundations-order-types')).toEqual({
      itemSlug: 'foundations-order-types',
      pathSlug: 'foundations',
      count: 0,
    });
    expect(bySlug.get('not-in-spine')).toEqual({ itemSlug: 'not-in-spine', pathSlug: null, count: 1 });
    expect(all.pathSlug).toBeNull();
    const markets = await operator.admin.completionsByItem({ from: '2026-10-17', to: '2026-10-18', pathSlug: 'markets' });
    const marketSlugs = listCurriculum({ path: 'markets' }).map((item) => item.slug);
    expect(markets.pathSlug).toBe('markets');
    expect(markets.items.map((row) => row.itemSlug).sort()).toEqual([...marketSlugs].sort());
    expect(markets.items.find((row) => row.itemSlug === 'markets-reading-the-book')?.count).toBe(1);
    expect(markets.items.filter((row) => row.itemSlug !== 'markets-reading-the-book').every((row) => row.count === 0)).toBe(true);
    expect(markets.items.some((row) => row.itemSlug === 'foundations-risk-first' || row.itemSlug === 'not-in-spine')).toBe(false);
    const body = JSON.stringify({ all, markets });
    expect(body).not.toContain(USER);
    expect(body).not.toContain(OTHER);
    expect(body).not.toContain(third);
    expect(body).not.toContain(fourth);
    await expect(operator.admin.completionsByItem({ from: '2026-10-17', to: '2026-10-17', pathSlug: 'no-such' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      cause: { code: 'academy.path_not_found' },
    });
    const reader = createAcademyRouter(academy).createCaller(signed(principal({ scopes: ['academy:write'] })));
    await expect(reader.admin.completionsByItem({ from: '2026-10-17', to: '2026-10-17' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
