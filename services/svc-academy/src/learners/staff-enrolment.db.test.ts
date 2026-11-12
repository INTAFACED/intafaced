/**
 * J-academy-15: staff enrolment, invitations, course email and learner exports, against a real database. Figures are
 * TEST values, not owner settings.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createHash } from 'node:crypto';
import { AcademyService, type AcademyServiceOptions } from '../academy-service.js';
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
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '55555555-5555-4555-8555-555555555555';
const STAFF = '33333333-3333-4333-8333-333333333333';
const EDGE_SECRET = 'an-academy-staff-enrolment-test-edge-secret';
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-academy' });
const TEST_LIMITS = { bulkEnrolRows: 5, bulkEmailInactiveDays: 30, reportRetentionHours: 1, learnerExportRows: 10 };

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

function service(options: Partial<AcademyServiceOptions> = TEST_LIMITS): AcademyService {
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
    { tournamentEnabled: false, paperTradingEnabled: false, ...options },
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
    id: 'req-staff-enrolment',
  });
  return createAcademyRouter(academy).createCaller(ctx);
}
const staff = (academy: AcademyService) => caller(academy, STAFF, ['admin:read', 'admin:write']);
const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { cause?: { code?: string } }) => e.cause?.code ?? 'no code',
  );
const activeEnrolments = async (path: string) =>
  (
    await db.sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM academy.cert_enrollments WHERE path_slug = ${path} AND left_at IS NULL`
  )[0]!.n;

describe('bulk enrolment', () => {
  it('answers each address, sends no mail, and the same upload again changes nothing', async () => {
    const academy = service();
    const rows = [
      { address: 'A@test.example', userId: A },
      { address: 'b@test.example ', userId: B },
      { address: 'nobody@test.example', userId: null },
      { address: 'not an address', userId: null },
      { address: 'a@test.example', userId: A },
    ];
    const first = await staff(academy).admin.bulkEnrol({ path: 'foundations', rows, reason: 'TEST cohort' });
    expect(first.mail).toBe('none');
    expect(first.replayed).toBe(false);
    expect(first.rows.map((r) => [r.address, r.outcome, r.code])).toEqual([
      ['a@test.example', 'enrolled', null],
      ['b@test.example', 'enrolled', null],
      ['nobody@test.example', 'refused', 'academy.learner_not_found'],
      ['not an address', 'refused', 'academy.address_invalid'],
      ['a@test.example', 'refused', 'academy.duplicate_address'],
    ]);
    expect(await activeEnrolments('foundations')).toBe(2);
    const events = await db.sql`SELECT key FROM academy.staff_enrolment_events`;
    const again = await staff(academy).admin.bulkEnrol({ path: 'foundations', rows: [...rows].reverse(), reason: 'TEST cohort' });
    expect(again.replayed).toBe(true);
    expect(again.rows).toEqual(first.rows);
    expect(await activeEnrolments('foundations')).toBe(2);
    expect(await db.sql`SELECT key FROM academy.staff_enrolment_events`).toHaveLength(events.length);
  });

  it('refuses a blank row limit and an upload over the limit, before anything is enrolled', async () => {
    const one = [{ address: 'a@test.example', userId: A }];
    expect(await codeOf(staff(service({})).admin.bulkEnrol({ path: 'foundations', rows: one, reason: 'TEST' }))).toBe(
      'academy.bulk_limit_unset',
    );
    const six = Array.from({ length: 6 }, (_, i) => ({ address: `p${i}@test.example`, userId: null }));
    expect(await codeOf(staff(service()).admin.bulkEnrol({ path: 'foundations', rows: six, reason: 'TEST' }))).toBe(
      'academy.bulk_limit_exceeded',
    );
    expect(await codeOf(staff(service()).admin.bulkEnrol({ path: 'foundations', rows: one, reason: '  ' }))).toBe(
      'academy.reason_required',
    );
    expect(await activeEnrolments('foundations')).toBe(0);
  });
});

describe('staff enrolment past a full course', () => {
  it('enrols, and the event records the bypass and the reason; a learner enrolling themselves is still refused', async () => {
    const academy = service();
    await academy.enrolCourse({ userId: A, slug: 'foundations', track: 'audit' });
    await academy.setCourseSeatCap({ slug: 'foundations', seatCap: 1, reason: 'TEST cap', operatorId: STAFF });
    await expect(academy.enrolCourse({ userId: C, slug: 'foundations', track: 'audit' })).rejects.toMatchObject({
      code: 'academy.enrolment_closed',
    });
    const done = await staff(academy).admin.staffEnrol({ path: 'foundations', userId: B, reason: 'TEST bursary seat' });
    expect(done.outcome).toBe('enrolled');
    expect(done.event).toMatchObject({ userId: B, bypassed: ['full'], reason: 'TEST bursary seat', actorId: STAFF, source: 'staff' });
    expect(done.event!.key).toBe(`enrol:foundations:${B}:1`);
    const listed = await staff(academy).admin.staffEnrolments({ path: 'foundations' });
    expect(listed[0]).toEqual(done.event);
    // The console reads the whole list with no filter, which sends no input at all.
    expect(await staff(academy).admin.staffEnrolments()).toEqual(listed);
    expect(await staff(academy).admin.courseInvitations()).toEqual([]);
    expect(await staff(academy).admin.bulkEmails()).toEqual([]);
    const repeat = await staff(academy).admin.staffEnrol({ path: 'foundations', userId: B, reason: 'TEST again' });
    expect(repeat).toEqual({ outcome: 'already_enrolled', event: null });
    expect(await staff(academy).admin.staffEnrolments({ path: 'foundations' })).toHaveLength(1);
  });

  it('a read-only session cannot enrol', async () => {
    const academy = service();
    await expect(
      caller(academy, STAFF, ['admin:read']).admin.staffEnrol({ path: 'foundations', userId: B, reason: 'TEST' }),
    ).rejects.toBeTruthy();
    expect(await activeEnrolments('foundations')).toBe(0);
  });
});

describe('invitations', () => {
  it('keeps a hash and a masked address once per course, and names the mail step', async () => {
    const academy = service();
    const made = await staff(academy).admin.inviteToCourse({ path: 'markets', address: 'New.Person@Test.example', reason: 'TEST' });
    expect(made).toMatchObject({ addressMask: 'n***@test.example', mail: 'vendor.email', replayed: false });
    const again = await staff(academy).admin.inviteToCourse({ path: 'markets', address: 'new.person@test.example ', reason: 'TEST' });
    expect(again.replayed).toBe(true);
    expect(again.key).toBe(made.key);
    const stored = await db.sql`SELECT * FROM academy.course_invitations`;
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('new.person');
    expect(await codeOf(staff(academy).admin.inviteToCourse({ path: 'markets', address: 'nope', reason: 'TEST' }))).toBe(
      'academy.address_invalid',
    );
  });
});

describe('course email', () => {
  it('is written refused for the missing provider, nobody is sent, opted-out and inactive learners are skipped', async () => {
    const academy = service();
    for (const userId of [A, B, C]) await academy.enrolCourse({ userId, slug: 'foundations', track: 'audit' });
    await caller(academy, B, ['academy:read', 'academy:write']).setCourseEmails({ slug: 'foundations', on: false });
    expect(await caller(academy, B, ['academy:read']).courseEmails({ slug: 'foundations' })).toEqual({ path: 'foundations', on: false });
    await db.sql`UPDATE academy.cert_enrollments SET enrolled_at = now() - interval '40 days' WHERE user_id = ${C}`;
    const sent = await staff(academy).admin.sendBulkEmail({
      path: 'foundations',
      subject: 'TEST',
      body: 'TEST body',
      key: 'mail:foundations:1',
    });
    expect(sent).toMatchObject({ state: 'refused', refusal: 'vendor.email', inactiveDays: 30, replayed: false });
    expect(sent.counts).toEqual({ not_sent: 1, sent: 0, skipped_opted_out: 1, skipped_inactive: 1 });
    expect(Object.fromEntries(sent.recipients.map((r) => [r.userId, r.state]))).toEqual({
      [A]: 'not_sent',
      [B]: 'skipped_opted_out',
      [C]: 'skipped_inactive',
    });
    const retry = await staff(academy).admin.sendBulkEmail({
      path: 'foundations',
      subject: 'TEST',
      body: 'TEST body',
      key: 'mail:foundations:1',
    });
    expect(retry.replayed).toBe(true);
    expect(retry.id).toBe(sent.id);
    expect(await staff(academy).admin.bulkEmails({ path: 'foundations' })).toHaveLength(1);
  });

  it('refuses a blank inactivity period before anything is written', async () => {
    const academy = service({ ...TEST_LIMITS, bulkEmailInactiveDays: undefined });
    await academy.enrolCourse({ userId: A, slug: 'foundations', track: 'audit' });
    expect(
      await codeOf(staff(academy).admin.sendBulkEmail({ path: 'foundations', subject: 'TEST', body: 'TEST', key: 'mail:foundations:1' })),
    ).toBe('academy.inactivity_period_unset');
    expect(await db.sql`SELECT id FROM academy.bulk_emails`).toHaveLength(0);
  });
});

describe('learner export', () => {
  it('finishes with only the tagged learners, its time and the hash of its file; a retry reuses the task', async () => {
    let job: (() => Promise<void>) | null = null;
    const academy = service();
    // Run the background job by hand, so the test sees queued and then done.
    (academy.staffEnrolment as unknown as { schedule: (j: () => Promise<void>) => void }).schedule = (j) => {
      job = j;
    };
    for (const userId of [A, B, C]) await academy.enrolCourse({ userId, slug: 'foundations', track: 'audit' });
    await staff(academy).admin.tagLearners({ userIds: [A, C], tag: 'test-cohort', reason: 'TEST' });
    const asked = await staff(academy).admin.requestLearnerExport({ tag: 'test-cohort', key: 'report:learners:test-cohort:1' });
    expect(asked).toMatchObject({ state: 'queued', replayed: false });
    expect(await codeOf(staff(academy).admin.reportFile({ id: asked.id }))).toBe('academy.report_not_ready');
    await job!();
    const file = await staff(academy).admin.reportFile({ id: asked.id });
    expect(file.state).toBe('done');
    expect(file.rows).toBe(2);
    expect(file.finishedAt).not.toBeNull();
    expect(file.sha256).toBe(createHash('sha256').update(file.csv, 'utf8').digest('hex'));
    const learners = file.csv
      .split('\n')
      .slice(2)
      .map((line) => line.split(',')[0]);
    expect(learners.sort()).toEqual([A, C].sort());
    const retry = await staff(academy).admin.requestLearnerExport({ tag: 'test-cohort', key: 'report:learners:test-cohort:1' });
    expect(retry).toMatchObject({ id: asked.id, replayed: true });
  });

  it('refuses a blank retention or row limit', async () => {
    expect(
      await codeOf(
        staff(service({ ...TEST_LIMITS, reportRetentionHours: undefined })).admin.requestLearnerExport({
          tag: null,
          key: 'report:learners::1',
        }),
      ),
    ).toBe('academy.report_retention_unset');
    expect(
      await codeOf(
        staff(service({ ...TEST_LIMITS, learnerExportRows: undefined })).admin.requestLearnerExport({
          tag: null,
          key: 'report:learners::1',
        }),
      ),
    ).toBe('academy.report_limit_unset');
  });
});
