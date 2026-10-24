/**
 * AC-catalogue-03 and AC-enrolment-01 — a published course staff made in the public catalogue, its page, and enrolling.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from './courses.js';
import { LessonRecords } from './lessons.js';
import { CoursePreview } from './course-preview.js';
import { CourseLearners } from './course-learners.js';

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
const LATER = new Date('2026-10-23T13:00:00.000Z');

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

const courses = () => new CourseRecords(db.sql, { maxSections: 5, maxItems: 3 });
const lessons = () => new LessonRecords(db.sql, courses());
const text = (markdown: string) => [{ type: 'text' as const, markdown }];

/** A draft course with one section: a subheader, a lesson and a link. Answers with the course and the stored items. */
async function draftWithOutline() {
  const course = await courses().create({
    slug: 'risk-basics',
    title: 'Risk basics',
    summary: null,
    thumbnailUrl: null,
    pricing: 'free',
    price: null,
    priceAsset: null,
    operatorId: A,
    now: NOW,
  });
  const detail = await courses().saveOutline({
    courseId: course.id,
    revision: 1,
    sections: [
      {
        title: 'Start here',
        items: [
          { kind: 'subheader', title: 'Part 1', indent: 0, url: null },
          { kind: 'lesson', title: 'Position size', indent: 0, url: null },
          { kind: 'link', title: 'Reading', indent: 0, url: 'https://example.com/read' },
        ],
      },
    ],
    operatorId: A,
    now: NOW,
  });
  const [subheader, lesson, link] = detail.outline[0]!.items;
  return { course: detail.course, section: detail.outline[0]!, subheader: subheader!, lesson: lesson!, link: link! };
}

const learners = () => new CourseLearners(db.sql, new CoursePreview(db.sql));
const L = '55555555-5555-4555-8555-555555555555';

/** The draft with its lesson live, then published. */
async function published() {
  const made = await draftWithOutline();
  const saved = await lessons().save({ itemId: made.lesson.id, revision: 0, blocks: text('One'), operatorId: A, now: NOW });
  await lessons().publish({
    itemId: made.lesson.id,
    lessonRevision: 1,
    courseRevision: saved.courseRevision,
    reason: 'TEST',
    operatorId: A,
    now: NOW,
  });
  const current = await courses().get(made.course.id);
  await courses().setState({
    courseId: made.course.id,
    to: 'published',
    revision: current.course.revision,
    reason: 'TEST',
    operatorId: A,
    now: NOW,
  });
  return made;
}

describe('the public catalogue and page of a course staff made (AC-catalogue-03)', () => {
  it('a draft is neither listed nor found; published, it is both', async () => {
    const { course } = await draftWithOutline();
    expect(await learners().published(10)).toEqual([]);
    await expect(learners().page('risk-basics', null)).rejects.toMatchObject({ code: 'academy.course_not_found' });
    await expect(learners().terms({ userId: L, slug: 'risk-basics' })).rejects.toMatchObject({ code: 'academy.course_not_found' });
    await db.sql`DELETE FROM academy.course_sections WHERE course_id = ${course.id}`;
    await db.sql`DELETE FROM academy.course_events WHERE course_id = ${course.id}`;
    await db.sql`DELETE FROM academy.courses WHERE id = ${course.id}`;

    await published();
    expect(await learners().published(10)).toEqual([
      {
        slug: 'risk-basics',
        title: 'Risk basics',
        summary: null,
        thumbnailUrl: null,
        pricing: 'free',
        price: null,
        priceAsset: null,
        items: 2,
      },
    ]);
    const page = await learners().page('risk-basics', null);
    expect(page.sections[0]!.items.map((i) => i.lock)).toEqual([null, 'enrol', 'enrol']);
    await expect(learners().page('no-such-course', null)).rejects.toMatchObject({ code: 'academy.course_not_found' });
  });
});

describe('enrolling in a course staff made (AC-enrolment-01)', () => {
  it('enrols on the free track once, opens what is released to that learner, and leaves by the enrolment it ends', async () => {
    await published();
    const terms = await learners().terms({ userId: L, slug: 'risk-basics' });
    expect(terms).toEqual({
      slug: 'risk-basics',
      startsAt: null,
      seatCap: null,
      seatsRemaining: null,
      closed: null,
      tracks: [{ track: 'audit', free: true, closed: null }],
      enrolment: null,
      activationMail: 'vendor.email',
    });
    const first = await learners().enrol({ userId: L, slug: 'risk-basics', track: 'audit', now: NOW });
    expect(first.enrolment).toEqual({ track: 'audit', enrolledAt: NOW.toISOString() });
    // A repeat answers with the same enrolment.
    expect(await learners().enrol({ userId: L, slug: 'risk-basics', track: 'audit', now: LATER })).toEqual(first);
    const [count] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM academy.course_enrolments`;
    expect(count?.n).toBe(1);
    expect((await learners().page('risk-basics', L)).sections[0]!.items.map((i) => i.lock)).toEqual([null, null, null]);
    expect((await learners().page('risk-basics', A)).sections[0]!.items.map((i) => i.lock)).toEqual([null, 'enrol', 'enrol']);

    const left = await learners().leave({ userId: L, slug: 'risk-basics', enrolledAt: NOW.toISOString(), now: LATER });
    expect(left.enrolment).toBeNull();
    // Enrolled again, a late repeat of the first leave does not end the new enrolment.
    const again = await learners().enrol({ userId: L, slug: 'risk-basics', track: 'audit', now: LATER });
    expect(await learners().leave({ userId: L, slug: 'risk-basics', enrolledAt: NOW.toISOString(), now: LATER })).toEqual(again);
  });

  it('a paid course keeps its paid track closed: payments are off; a closed track refuses', async () => {
    const { course } = await published();
    await db.sql`UPDATE academy.courses SET pricing = 'paid', price = '25.5', price_asset = 'USDT' WHERE id = ${course.id}`;
    const terms = await learners().terms({ userId: L, slug: 'risk-basics' });
    expect(terms.tracks).toEqual([
      { track: 'audit', free: true, closed: null },
      { track: 'certificate', free: false, closed: 'payments_off' },
    ]);
    expect((await learners().published(10))[0]).toMatchObject({ pricing: 'paid', price: '25.5', priceAsset: 'USDT' });
    await expect(learners().enrol({ userId: L, slug: 'risk-basics', track: 'certificate', now: NOW })).rejects.toMatchObject({
      code: 'academy.enrolment_closed',
    });
    expect((await learners().enrol({ userId: L, slug: 'risk-basics', track: 'audit', now: NOW })).enrolment).not.toBeNull();
  });
});
