/**
 * AC-programmes-01: learning programmes against Postgres. Staff save a programme of courses over its revision, with an
 * event row; a learner reads the three counts move as they enrol and finish courses; finishing the last course issues the
 * programme certificate once; a blank owner limit and the other typed refusals hold.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from '../academy-service.js';
import { NullStreamProvider } from '../stream/provider.js';
import { listCurriculum, type CurriculumPath } from './catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const db: TestDatabase = await createTestDatabase({ service: 'academy', url: adminUrl(), migrations: MIGRATIONS });
const sql = db.sql;
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '44444444-4444-4444-8444-444444444444';
const T0 = new Date('2026-10-24T12:00:00.000Z');
const COURSES: CurriculumPath[] = ['markets', 'builder', 'sovereign'];
const CERT = 'programme:trader-path';

function service(programmeMaxCourses: number | null = 4) {
  return new AcademyService(
    sql,
    { stakeOf: async () => 0n },
    {
      async perksOf() {
        throw new Error('host rights unused');
      },
    },
    new NullStreamProvider(),
    { tournamentEnabled: false, paperTradingEnabled: false, ...(programmeMaxCourses ? { programmeMaxCourses } : {}) },
  );
}

const save = (academy: AcademyService, over: Partial<Parameters<AcademyService['saveProgramme']>[0]> = {}) =>
  academy.saveProgramme({
    slug: 'trader-path',
    title: 'TEST Trader path',
    summary: 'TEST three courses',
    courseSlugs: COURSES,
    expectedRevision: null,
    reason: 'TEST a programme',
    operatorId: OPERATOR,
    now: T0,
    ...over,
  });

async function finish(academy: AcademyService, course: CurriculumPath, userId = USER) {
  await academy.enrolCourse({ userId, slug: course, track: 'audit' });
  for (const row of listCurriculum({ path: course })) await academy.markCurriculumComplete({ userId, itemSlug: row.slug, now: T0 });
}

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

describe('learning programmes', () => {
  it('saves a programme as revision 1 with its courses in order and one event row; a repeat writes nothing', async () => {
    const academy = service();
    const first = await save(academy);
    expect(first).toMatchObject({ slug: 'trader-path', courseSlugs: COURSES, revision: 1 });
    expect(await save(academy)).toEqual(first);
    const events = await sql`SELECT revision, course_slugs, operator_id, reason FROM academy.programme_events`;
    expect(events).toEqual([{ revision: 1, course_slugs: COURSES, operator_id: OPERATOR, reason: 'TEST a programme' }]);
  });

  it('replaces the courses over the revision read, and refuses a stale revision or a taken address', async () => {
    const academy = service();
    await save(academy);
    const second = await save(academy, { courseSlugs: ['builder', 'markets'], expectedRevision: 1 });
    expect(second).toMatchObject({ courseSlugs: ['builder', 'markets'], revision: 2 });
    await expect(save(academy, { title: 'TEST late', expectedRevision: 1 })).rejects.toMatchObject({ code: 'academy.revision_stale' });
    await expect(save(academy, { title: 'TEST another' })).rejects.toMatchObject({ code: 'academy.programme_slug_taken' });
    await expect(save(academy, { slug: 'nowhere', expectedRevision: 1 })).rejects.toMatchObject({ code: 'academy.programme_not_found' });
  });

  it('refuses a save with courses while the owner limit is blank, past the limit, and at a reserved address', async () => {
    await expect(save(service(null))).rejects.toMatchObject({ code: 'academy.programme_limit_unset' });
    // A programme with no course needs no limit: it is shown with its empty state.
    await expect(save(service(null), { slug: 'empty-path', courseSlugs: [] })).resolves.toMatchObject({ courseSlugs: [] });
    await expect(save(service(2))).rejects.toMatchObject({ code: 'academy.programme_too_large' });
    await expect(save(service(), { slug: 'invitations' })).rejects.toMatchObject({ code: 'academy.slug_reserved' });
    expect(await sql`SELECT slug FROM academy.programmes`).toEqual([{ slug: 'empty-path' }]);
  });

  it('counts completed, enrolled and not enrolled as the learner goes, and issues the certificate once at the end', async () => {
    const academy = service();
    await save(academy);
    const read = () => academy.programme({ userId: USER, slug: 'trader-path', now: T0 });
    expect((await read()).counts).toEqual({ completed: 0, enrolled: 0, notEnrolled: 3 });
    await academy.enrolCourse({ userId: USER, slug: 'markets', track: 'audit' });
    expect((await read()).counts).toEqual({ completed: 0, enrolled: 1, notEnrolled: 2 });
    await finish(academy, 'markets');
    expect((await read()).counts).toEqual({ completed: 1, enrolled: 0, notEnrolled: 2 });
    await finish(academy, 'builder');
    expect((await read()).certificate).toEqual({ state: 'not_earned', certId: CERT });
    await finish(academy, 'sovereign');
    const done = await read();
    expect(done.counts).toEqual({ completed: 3, enrolled: 0, notEnrolled: 0 });
    expect(done.courses.map((row) => row.state)).toEqual(['completed', 'completed', 'completed']);
    expect(done.certificate).toMatchObject({ state: 'earned', certId: CERT, status: 'valid' });
    // Issued by the last completion itself, once; every later read answers the same grant.
    expect(await read()).toEqual(done);
    expect(await sql`SELECT cert_id, idempotency_key FROM academy.cert_grants WHERE user_id = ${USER}`).toEqual([
      { cert_id: CERT, idempotency_key: `cert:${USER}:${CERT}` },
    ]);
    // Another learner's counts are their own.
    expect((await academy.programme({ userId: OTHER, slug: 'trader-path' })).counts).toEqual({ completed: 0, enrolled: 0, notEnrolled: 3 });
    // The public check names the programme.
    if (done.certificate.state !== 'earned') throw new Error('not earned');
    expect(await academy.certVerify(done.certificate.publicId)).toMatchObject({ certId: CERT, title: 'TEST Trader path', status: 'valid' });
  });

  it('issues on the next read when the completion could not, and an Undo after the issue keeps the certificate', async () => {
    const academy = service();
    for (const course of COURSES) await finish(academy, course);
    // The programme was made after the learner finished: no completion issued it, the read does.
    await save(academy);
    const read = await academy.programme({ userId: USER, slug: 'trader-path' });
    expect(read.certificate.state).toBe('earned');
    const [last] = listCurriculum({ path: 'sovereign' }).slice(-1);
    const [row] = await sql<Array<{ completed_at: Date }>>`
      SELECT completed_at FROM academy.cert_item_completions WHERE user_id = ${USER} AND item_slug = ${last!.slug}
    `;
    await academy.undoCurriculumComplete({
      userId: USER,
      itemSlug: last!.slug,
      completedAt: row!.completed_at.toISOString(),
      clientRequestId: 'undo-1',
    });
    const after = await academy.programme({ userId: USER, slug: 'trader-path' });
    expect(after.counts.completed).toBe(2);
    expect(after.certificate).toEqual(read.certificate);
  });

  it('lists programmes newest first up to the limit, an empty programme with no counts, and refuses an unknown one', async () => {
    const academy = service();
    await save(academy, { slug: 'empty-path', courseSlugs: [] });
    await save(academy, { now: new Date(T0.getTime() + 1000) });
    const list = await academy.programmes({ userId: USER, limit: 1 });
    expect(list.map((row) => row.slug)).toEqual(['trader-path']);
    const [, empty] = await academy.programmes({ userId: USER, limit: 10 });
    expect(empty).toMatchObject({ slug: 'empty-path', courses: [], counts: { completed: 0, enrolled: 0, notEnrolled: 0 } });
    expect(empty!.certificate.state).toBe('not_earned');
    await expect(academy.programme({ userId: USER, slug: 'missing' })).rejects.toMatchObject({ code: 'academy.programme_not_found' });
  });
});
