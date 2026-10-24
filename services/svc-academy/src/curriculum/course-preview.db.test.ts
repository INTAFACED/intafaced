/**
 * AC-catalogue-03 — Preview as new learner and private links to a course's unlisted page.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from './courses.js';
import { LessonRecords } from './lessons.js';
import { CoursePreview } from './course-preview.js';

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

const preview = () => new CoursePreview(db.sql);

/** Every academy table's row count, to prove a read wrote nothing. */
async function counts() {
  const tables = await db.sql<Array<{ name: string }>>`
    SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'academy' AND table_type = 'BASE TABLE' ORDER BY 1
  `;
  const out: Record<string, number> = {};
  for (const { name } of tables) {
    const [row] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM ${db.sql('academy')}.${db.sql(name)}`;
    out[name] = row!.n;
  }
  return out;
}

describe('Preview as new learner (AC-catalogue-03)', () => {
  it('shows the real syllabus with locks and writes nothing', async () => {
    const { course, lesson } = await draftWithOutline();
    const before = await counts();
    expect(await preview().preview(course.id)).toEqual({
      slug: 'risk-basics',
      title: 'Risk basics',
      summary: null,
      thumbnailUrl: null,
      pricing: 'free',
      price: null,
      priceAsset: null,
      state: 'draft',
      sections: [
        {
          title: 'Start here',
          items: [
            { id: expect.any(String), kind: 'subheader', title: 'Part 1', indent: 0, lock: null },
            { id: expect.any(String), kind: 'lesson', title: 'Position size', indent: 0, lock: 'not_released' },
            { id: expect.any(String), kind: 'link', title: 'Reading', indent: 0, lock: 'enrolment_closed' },
          ],
        },
      ],
    });
    expect(await counts()).toEqual(before);

    const saved = await lessons().save({ itemId: lesson.id, revision: 0, blocks: text('One'), operatorId: A, now: NOW });
    await lessons().publish({
      itemId: lesson.id,
      lessonRevision: 1,
      courseRevision: saved.courseRevision,
      reason: 'TEST',
      operatorId: A,
      now: NOW,
    });
    expect((await preview().preview(course.id)).sections[0]!.items[1]).toMatchObject({ title: 'Position size', lock: 'enrolment_closed' });
    // Published, the released items wait only for the reader's enrolment.
    const current = await courses().get(course.id);
    await courses().setState({
      courseId: course.id,
      to: 'published',
      revision: current.course.revision,
      reason: 'TEST',
      operatorId: A,
      now: NOW,
    });
    const live = await preview().preview(course.id);
    expect(live.state).toBe('published');
    expect(live.sections[0]!.items.map((i) => i.lock)).toEqual([null, 'enrol', 'enrol']);
  });

  it('an unknown course is not found', async () => {
    await expect(preview().preview(B)).rejects.toMatchObject({ code: 'academy.course_not_found' });
  });
});

describe('private links (AC-catalogue-03)', () => {
  it('a link opens the unlisted page; only its hash is stored; a revoked one is not found', async () => {
    const { course } = await draftWithOutline();
    const made = await preview().createLink({ courseId: course.id, reason: 'TEST reviewer', operatorId: A, now: NOW });
    expect(made.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.path).toBe(`/academy/learning/course/risk-basics#key=${made.key}`);
    expect(made.link).toMatchObject({ reason: 'TEST reviewer', createdBy: A, revokedAt: null });
    const stored = await db.sql`SELECT key_sha256 FROM academy.course_private_links`;
    expect(JSON.stringify(stored)).not.toContain(made.key);

    const before = await counts();
    expect(await preview().byLink({ slug: 'risk-basics', key: made.key })).toMatchObject({ title: 'Risk basics', state: 'draft' });
    expect(await counts()).toEqual(before);
    await expect(preview().byLink({ slug: 'other-course', key: made.key })).rejects.toMatchObject({ code: 'academy.course_not_found' });
    await expect(preview().byLink({ slug: 'risk-basics', key: made.key.slice(1) })).rejects.toMatchObject({
      code: 'academy.course_not_found',
    });
    await expect(preview().byLink({ slug: 'risk-basics', key: 'x'.repeat(43) })).rejects.toMatchObject({
      code: 'academy.course_not_found',
    });

    const revoked = await preview().revokeLink({ linkId: made.link.id, reason: 'TEST done', operatorId: B, now: LATER });
    expect(revoked).toMatchObject({ revokedBy: B, revokedAt: LATER.toISOString(), revokeReason: 'TEST done' });
    // A repeat answers with the link as it was first revoked.
    expect(await preview().revokeLink({ linkId: made.link.id, reason: 'again', operatorId: A, now: NOW })).toEqual(revoked);
    await expect(preview().byLink({ slug: 'risk-basics', key: made.key })).rejects.toMatchObject({ code: 'academy.course_not_found' });
    expect(await preview().links(course.id)).toEqual([revoked]);
    await expect(preview().links(B)).rejects.toMatchObject({ code: 'academy.course_not_found' });
    await expect(preview().revokeLink({ linkId: B, reason: 'x', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.private_link_not_found',
    });
  });

  it('an archived course opens through no link and takes no new one', async () => {
    const { course } = await draftWithOutline();
    const made = await preview().createLink({ courseId: course.id, reason: 'TEST', operatorId: A, now: NOW });
    await db.sql`UPDATE academy.courses SET state = 'archived' WHERE id = ${course.id}`;
    await expect(preview().byLink({ slug: 'risk-basics', key: made.key })).rejects.toMatchObject({ code: 'academy.course_not_found' });
    await expect(preview().createLink({ courseId: course.id, reason: 'TEST', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.private_link_course_closed',
    });
    await expect(preview().createLink({ courseId: B, reason: 'TEST', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.course_not_found',
    });
  });
});
