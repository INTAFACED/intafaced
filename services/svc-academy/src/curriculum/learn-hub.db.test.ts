/**
 * AC-articles-01 — the Learn hub's featured article (a course lesson learners can read) and topics.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from './courses.js';
import { LessonRecords } from './lessons.js';
import { LearnHub } from './learn-hub.js';
import { listCurriculumSlugs } from './catalog.js';

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

const hub = (limit: number | null = 10) => new LearnHub(db.sql, limit);

describe('the Learn hub featured article (AC-articles-01)', () => {
  it('only a lesson learners can read is featured; withdrawing it empties the slot; a repeat withdrawal answers the same', async () => {
    const { course, lesson, subheader } = await draftWithOutline();
    await expect(hub().featureLesson({ itemId: lesson.id, reason: 'TEST', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.featured_not_live',
    });
    await expect(hub().featureLesson({ itemId: subheader.id, reason: 'TEST', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.item_has_no_lesson',
    });
    expect(await hub().featuredSlot()).toEqual({ curriculum: null, lesson: null, reason: null, chosenBy: null, chosenAt: null });

    const saved = await lessons().save({ itemId: lesson.id, revision: 0, blocks: text('One'), operatorId: A, now: NOW });
    const live = await lessons().publish({
      itemId: lesson.id,
      lessonRevision: 1,
      courseRevision: saved.courseRevision,
      reason: 'TEST',
      operatorId: A,
      now: NOW,
    });
    const slot = await hub().featureLesson({ itemId: lesson.id, reason: 'TEST first article', operatorId: B, now: LATER });
    expect(slot).toMatchObject({
      lesson: { itemId: lesson.id, title: 'Position size', courseTitle: 'Risk basics', courseState: 'draft', liveRevision: 1 },
      reason: 'TEST first article',
      chosenBy: B,
    });
    expect((await lessons().get(lesson.id)).featured).toBe(true);
    // Visitors see its title and course; the course's address only once the course is published.
    expect(await hub().publicLesson()).toEqual({ title: 'Position size', courseTitle: 'Risk basics', courseSlug: null });
    const published = await db.sql<Array<{ slug: string }>>`
      UPDATE academy.courses SET state = 'published' WHERE id = ${course.id} RETURNING slug
    `;
    const slug = published[0]!.slug;
    expect(await hub().publicLesson()).toEqual({ title: 'Position size', courseTitle: 'Risk basics', courseSlug: slug });
    await db.sql`UPDATE academy.courses SET state = 'draft' WHERE id = ${course.id}`;

    const withdrawn = await lessons().withdraw({
      itemId: lesson.id,
      courseRevision: live.courseRevision,
      reason: 'TEST pulled',
      operatorId: A,
      now: LATER,
    });
    expect(withdrawn).toMatchObject({ featured: false, item: { liveRevision: null }, courseRevision: live.courseRevision + 1 });
    expect((await hub().featuredSlot()).lesson).toBeNull();
    expect(await hub().publicLesson()).toBeNull();
    const trail = await db.sql`SELECT action, reason, actor FROM academy.featured_events ORDER BY at, action`;
    expect(trail).toEqual([
      { action: 'featured', reason: 'TEST first article', actor: B },
      { action: 'withdrawn', reason: 'TEST pulled', actor: A },
    ]);
    expect(
      await lessons().withdraw({
        itemId: lesson.id,
        courseRevision: live.courseRevision,
        reason: 'TEST pulled',
        operatorId: A,
        now: LATER,
      }),
    ).toEqual(withdrawn);
    await expect(
      lessons().withdraw({ itemId: lesson.id, courseRevision: withdrawn.courseRevision, reason: 'TEST', operatorId: A, now: LATER }),
    ).rejects.toMatchObject({ code: 'academy.lesson_not_live' });
    await expect(
      lessons().withdraw({ itemId: lesson.id, courseRevision: live.courseRevision, reason: 'TEST', operatorId: B, now: LATER }),
    ).rejects.toMatchObject({ code: 'academy.course_revision_stale' });
  });

  it('the one slot shows a curriculum item too; clearing empties it and records who and why', async () => {
    const spine = { slug: listCurriculumSlugs()[0]! };
    await db.sql`
      INSERT INTO academy.featured_items (slot, item_slug, reason, chosen_by, chosen_at) VALUES ('hub', ${spine.slug}, 'TEST', ${A}, ${NOW})
    `;
    expect(await hub().featuredSlot()).toMatchObject({ curriculum: { slug: spine.slug }, lesson: null, reason: 'TEST' });
    expect(await hub().publicLesson()).toBeNull();
    await hub().clearFeatured({ reason: 'TEST tidy', operatorId: B, now: LATER });
    expect((await hub().featuredSlot()).curriculum).toBeNull();
    const events = await db.sql`SELECT action, item_slug, reason, actor FROM academy.featured_events ORDER BY at`;
    expect(events).toEqual([{ action: 'cleared', item_slug: spine.slug, reason: 'TEST tidy', actor: B }]);
  });

  it('a lesson in a course that is no longer draft or published leaves the slot and is not featured', async () => {
    const { course, lesson } = await draftWithOutline();
    const saved = await lessons().save({ itemId: lesson.id, revision: 0, blocks: text('One'), operatorId: A, now: NOW });
    await lessons().publish({
      itemId: lesson.id,
      lessonRevision: 1,
      courseRevision: saved.courseRevision,
      reason: 'TEST',
      operatorId: A,
      now: NOW,
    });
    await hub().featureLesson({ itemId: lesson.id, reason: 'TEST', operatorId: A, now: NOW });
    await db.sql`UPDATE academy.courses SET state = 'archived' WHERE id = ${course.id}`;
    expect((await hub().featuredSlot()).lesson).toBeNull();
    expect(await hub().publicLesson()).toBeNull();
    await expect(hub().featureLesson({ itemId: lesson.id, reason: 'TEST', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.course_not_editable',
    });
  });
});

describe('topics (AC-articles-01)', () => {
  it('a tab address is refused; a repeat answers with the topic; another name at the address is refused; the list needs its limit', async () => {
    await expect(hub().createTopic({ slug: 'learning', name: 'Learning', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.slug_reserved',
    });
    const risk = await hub().createTopic({ slug: 'risk', name: 'Risk', operatorId: A, now: NOW });
    expect(await hub().createTopic({ slug: 'risk', name: 'Risk', operatorId: B, now: LATER })).toEqual(risk);
    await expect(hub().createTopic({ slug: 'risk', name: 'Other', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.topic_slug_taken',
    });
    await hub().createTopic({ slug: 'charts', name: 'Charts', operatorId: A, now: LATER });
    expect(await hub(1).topics()).toEqual({ topics: [expect.objectContaining({ slug: 'charts' })], limit: 1 });
    await expect(hub(null).topics()).rejects.toMatchObject({ code: 'academy.topics_list_limit_unset' });
  });

  it('a course is filed under topics over the revision read; a repeat answers with it; an unknown topic is refused', async () => {
    const { course } = await draftWithOutline();
    const risk = await hub().createTopic({ slug: 'risk', name: 'Risk', operatorId: A, now: NOW });
    await expect(
      courses().setTopics({
        courseId: course.id,
        revision: course.revision,
        topicIds: ['99999999-9999-4999-8999-999999999999'],
        operatorId: A,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.topic_not_found' });
    const filed = await courses().setTopics({
      courseId: course.id,
      revision: course.revision,
      topicIds: [risk.id],
      operatorId: A,
      now: NOW,
    });
    expect(filed.topics).toEqual([risk]);
    expect(filed.course.revision).toBe(course.revision + 1);
    expect(filed.events[0]).toMatchObject({ kind: 'topics', actor: A });
    expect(
      await courses().setTopics({ courseId: course.id, revision: course.revision, topicIds: [risk.id], operatorId: A, now: NOW }),
    ).toEqual(filed);
    await expect(
      courses().setTopics({ courseId: course.id, revision: course.revision, topicIds: [], operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.course_revision_stale' });
  });
});
