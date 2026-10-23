/**
 * AC-course-structure-01 — course records: a draft with a fixed slug, edits over a revision, every move with who and why,
 * and publish refusing a paid course with no price and a course with nothing in it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from './courses.js';

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
const A = '33333333-3333-4333-8333-333333333333';
const B = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const free = {
  slug: 'risk-basics',
  title: 'Risk basics',
  summary: null,
  thumbnailUrl: null,
  pricing: 'free' as const,
  price: null,
  priceAsset: null,
};

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

const records = () => new CourseRecords(db.sql);

describe('creating a course', () => {
  it('saves a draft at revision 1 with a created event, and a repeat answers with the stored course', async () => {
    const course = await records().create({ ...free, operatorId: A, now: NOW });
    expect(course).toMatchObject({ slug: 'risk-basics', state: 'draft', revision: 1, items: 0, createdBy: A });
    expect(await records().create({ ...free, operatorId: A, now: new Date() })).toEqual(course);
    const detail = await records().get(course.id);
    expect(detail.events).toEqual([
      { kind: 'created', revision: 1, fromState: null, toState: 'draft', actor: A, reason: null, at: NOW.toISOString() },
    ]);
  });

  it('refuses a reserved tab, a shipped course and a lesson address, and a taken slug with other details', async () => {
    await expect(records().create({ ...free, slug: 'videos', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.slug_reserved',
    });
    await expect(records().create({ ...free, slug: 'markets', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.course_slug_taken',
    });
    await expect(records().create({ ...free, slug: 'foundations-risk-first', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.course_slug_taken',
    });
    await records().create({ ...free, operatorId: A, now: NOW });
    await expect(records().create({ ...free, title: 'Another', operatorId: B, now: NOW })).rejects.toMatchObject({
      code: 'academy.course_slug_taken',
    });
    // The same details from another founder are not their create: the course is someone else's.
    await expect(records().create({ ...free, operatorId: B, now: NOW })).rejects.toMatchObject({ code: 'academy.course_slug_taken' });
    expect((await records().list({ limit: 10 })).counts.draft).toBe(1);
  });
});

describe('editing and publishing', () => {
  it('an edit goes over the revision read; a lost reply repeated answers with it, a stale one is refused', async () => {
    const course = await records().create({ ...free, pricing: 'paid', operatorId: A, now: NOW });
    const edit = { ...free, courseId: course.id, revision: 1, pricing: 'paid' as const, price: '25.50', priceAsset: 'USDT' };
    const edited = await records().update({ ...edit, operatorId: A, now: NOW });
    expect(edited).toMatchObject({ revision: 2, price: '25.5', priceAsset: 'USDT' });
    expect(await records().update({ ...edit, operatorId: A, now: NOW })).toEqual(edited);
    await expect(records().update({ ...edit, title: 'Other', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.course_revision_stale',
    });
    await expect(records().update({ ...edit, operatorId: B, now: NOW })).rejects.toMatchObject({
      code: 'academy.course_revision_stale',
    });
  });

  it('publishing a paid course with no price refuses price_unset and changes nothing', async () => {
    const course = await records().create({ ...free, pricing: 'paid', operatorId: A, now: NOW });
    await expect(
      records().setState({ courseId: course.id, to: 'published', revision: 1, reason: 'ready', operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.price_unset' });
    const detail = await records().get(course.id);
    expect(detail.course).toMatchObject({ state: 'draft', revision: 1 });
    expect(detail.events).toHaveLength(1);
  });

  it('publishing a course with an empty outline refuses by name; a stale revision and an unknown id are refused', async () => {
    const course = await records().create({ ...free, operatorId: A, now: NOW });
    await expect(
      records().setState({ courseId: course.id, to: 'published', revision: 1, reason: 'ready', operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.course_outline_empty' });
    await expect(
      records().setState({ courseId: course.id, to: 'published', revision: 7, reason: 'ready', operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.course_revision_stale' });
    await expect(records().get('55555555-5555-4555-8555-555555555555')).rejects.toMatchObject({ code: 'academy.course_not_found' });
  });

  it('the database itself refuses a published paid course with no price', async () => {
    const course = await records().create({ ...free, pricing: 'paid', operatorId: A, now: NOW });
    await expect(db.sql`UPDATE academy.courses SET state = 'published' WHERE id = ${course.id}`).rejects.toThrow(
      /courses_published_price_chk/,
    );
  });
});

describe('the list', () => {
  it('needs a page size, filters by state and counts every state', async () => {
    await expect(records().list({})).rejects.toMatchObject({ code: 'academy.courses_list_limit_unset' });
    expect(await records().list({ limit: 5 })).toEqual({
      courses: [],
      counts: { draft: 0, published: 0, concluded: 0, archived: 0, deleted: 0 },
    });
    await records().create({ ...free, operatorId: A, now: NOW });
    await records().create({ ...free, slug: 'risk-two', operatorId: A, now: new Date(NOW.getTime() + 1000) });
    const page = await records().list({ limit: 1 });
    expect(page.courses.map((c) => c.slug)).toEqual(['risk-two']);
    expect(page.counts.draft).toBe(2);
    expect((await records().list({ state: 'published', limit: 5 })).courses).toEqual([]);
  });
});
