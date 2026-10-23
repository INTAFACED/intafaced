/**
 * AC-course-structure-03 — lessons: revisions of ordered blocks, revert, publish to learners, duplicate, and outline
 * saves that keep an item (and its lesson) by id.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from './courses.js';
import { LessonRecords } from './lessons.js';

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

describe('lesson revisions (AC-course-structure-03)', () => {
  it('every save is a new revision; a repeat answers with it; an old read is stale; a label or a link holds no lesson', async () => {
    const { lesson, subheader, link } = await draftWithOutline();
    const first = await lessons().save({ itemId: lesson.id, revision: 0, blocks: text('One'), operatorId: A, now: NOW });
    expect(first.item).toMatchObject({ lessonRevision: 1, liveRevision: null });
    expect(first.revisions.map((r) => [r.revision, r.source])).toEqual([[1, 'saved']]);
    expect(await lessons().save({ itemId: lesson.id, revision: 0, blocks: text('One'), operatorId: A, now: LATER })).toEqual(first);
    await expect(lessons().save({ itemId: lesson.id, revision: 0, blocks: text('Other'), operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.revision_stale',
    });
    await expect(lessons().save({ itemId: lesson.id, revision: 0, blocks: text('One'), operatorId: B, now: NOW })).rejects.toMatchObject({
      code: 'academy.revision_stale',
    });
    for (const item of [subheader, link])
      await expect(lessons().save({ itemId: item.id, revision: 0, blocks: text('x'), operatorId: A, now: NOW })).rejects.toMatchObject({
        code: 'academy.item_has_no_lesson',
      });
  });

  it('learners keep the published revision while staff edit; republish moves them; revert makes a new revision', async () => {
    const { course, lesson } = await draftWithOutline();
    await lessons().save({ itemId: lesson.id, revision: 0, blocks: text('Live words'), operatorId: A, now: NOW });
    const live = await lessons().publish({
      itemId: lesson.id,
      lessonRevision: 1,
      courseRevision: course.revision,
      reason: 'first cut',
      operatorId: A,
      now: NOW,
    });
    expect(live.item.liveRevision).toBe(1);
    expect(live.courseRevision).toBe(course.revision + 1);
    // A repeat after a lost reply answers with the same state; nothing moves twice.
    expect(
      await lessons().publish({
        itemId: lesson.id,
        lessonRevision: 1,
        courseRevision: course.revision,
        reason: 'first cut',
        operatorId: A,
        now: LATER,
      }),
    ).toEqual(live);
    const edited = await lessons().save({ itemId: lesson.id, revision: 1, blocks: text('Draft words'), operatorId: A, now: NOW });
    expect(edited.item).toMatchObject({ lessonRevision: 2, liveRevision: 1 });
    const reverted = await lessons().revert({ itemId: lesson.id, revision: 2, toRevision: 1, operatorId: A, now: NOW });
    expect(reverted.revisions.map((r) => [r.revision, r.source, r.fromRevision])).toEqual([
      [3, 'reverted', 1],
      [2, 'saved', null],
      [1, 'saved', null],
    ]);
    expect(reverted.revisions[0]!.blocks).toEqual(text('Live words'));
    await expect(lessons().revert({ itemId: lesson.id, revision: 3, toRevision: 9, operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.lesson_revision_unknown',
    });
    const republished = await lessons().publish({
      itemId: lesson.id,
      lessonRevision: 2,
      courseRevision: live.courseRevision,
      reason: 'second cut',
      operatorId: A,
      now: NOW,
    });
    expect(republished.item.liveRevision).toBe(2);
    expect((await courses().get(course.id)).events[0]).toMatchObject({ kind: 'lesson', actor: A, reason: 'second cut' });
    await expect(
      lessons().publish({
        itemId: lesson.id,
        lessonRevision: 3,
        courseRevision: live.courseRevision,
        reason: 'old read',
        operatorId: A,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.course_revision_stale' });
  });

  it('an outline save keeps an item, and its lesson, by id; an id from another course is refused', async () => {
    const { course, section, subheader, lesson, link } = await draftWithOutline();
    await lessons().save({ itemId: lesson.id, revision: 0, blocks: text('Kept'), operatorId: A, now: NOW });
    const keep = (i: typeof lesson) => ({ id: i.id, kind: i.kind, title: i.title, indent: i.indent, url: i.url });
    const moved = await courses().saveOutline({
      courseId: course.id,
      revision: course.revision,
      sections: [
        { title: 'First', items: [{ ...keep(lesson), title: 'Position size, renamed' }] },
        { id: section.id, title: 'Start here', items: [keep(link), keep(subheader)] },
      ],
      operatorId: A,
      now: NOW,
    });
    expect(moved.outline.map((s) => s.items.map((i) => [i.id, i.title]))).toEqual([
      [[lesson.id, 'Position size, renamed']],
      [
        [link.id, 'Reading'],
        [subheader.id, 'Part 1'],
      ],
    ]);
    expect(moved.outline[1]!.id).toBe(section.id);
    expect((await lessons().get(lesson.id)).revisions[0]!.blocks).toEqual(text('Kept'));
    await expect(
      courses().saveOutline({
        courseId: course.id,
        revision: moved.course.revision,
        sections: [
          { title: 'x', items: [{ id: '55555555-5555-4555-8555-555555555555', kind: 'lesson', title: 'x', indent: 0, url: null }] },
        ],
        operatorId: A,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.outline_item_unknown' });
    // Dropping the item from the outline deletes it with its lesson.
    await courses().saveOutline({
      courseId: course.id,
      revision: moved.course.revision,
      sections: [{ id: section.id, title: 'Start here', items: [keep(link)] }],
      operatorId: A,
      now: NOW,
    });
    await expect(lessons().get(lesson.id)).rejects.toMatchObject({ code: 'academy.outline_item_unknown' });
  });

  it('a duplicate copies the item and its newest lesson right after it, not live and with no learner record', async () => {
    const { course, lesson, link } = await draftWithOutline();
    await lessons().save({ itemId: lesson.id, revision: 0, blocks: text('One'), operatorId: A, now: NOW });
    const live = await lessons().publish({
      itemId: lesson.id,
      lessonRevision: 1,
      courseRevision: course.revision,
      reason: 'go',
      operatorId: A,
      now: NOW,
    });
    await lessons().save({ itemId: lesson.id, revision: 1, blocks: text('Two'), operatorId: A, now: NOW });
    const copy = await lessons().duplicate({ itemId: lesson.id, courseRevision: live.courseRevision, operatorId: A, now: LATER });
    expect(copy.item).toMatchObject({ kind: 'lesson', title: 'Position size', lessonRevision: 1, liveRevision: null });
    expect(copy.revisions).toEqual([
      {
        revision: 1,
        source: 'duplicated',
        fromRevision: null,
        fromItemId: lesson.id,
        blocks: text('Two'),
        actor: A,
        at: LATER.toISOString(),
      },
    ]);
    expect(await lessons().duplicate({ itemId: lesson.id, courseRevision: live.courseRevision, operatorId: A, now: LATER })).toEqual(copy);
    const detail = await courses().get(course.id);
    expect(detail.outline[0]!.items.map((i) => i.id)).toEqual([detail.outline[0]!.items[0]!.id, lesson.id, copy.item.id, link.id]);
    expect(detail.events[0]).toMatchObject({ kind: 'outline', actor: A });
    // The item limit (3 a learner opens) is now full: lesson, copy and link.
    await expect(
      lessons().duplicate({ itemId: lesson.id, courseRevision: detail.course.revision, operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.outline_too_large' });
  });

  it("review findings: image replay, another item's publish, a lesson-less duplicate replay, kind lock, an old live revision", async () => {
    const { course, section, subheader, lesson, link } = await draftWithOutline();
    // jsonb reorders keys; a repeat of an image block still answers with its own revision.
    const image = [{ type: 'image' as const, url: 'https://example.com/a.png', alt: 'A chart' }];
    const saved = await lessons().save({ itemId: lesson.id, revision: 0, blocks: image, operatorId: A, now: NOW });
    expect(await lessons().save({ itemId: lesson.id, revision: 0, blocks: image, operatorId: A, now: LATER })).toEqual(saved);
    // A second lesson item, published; then a stale publish of it over the first item's publish is refused.
    const copy = await lessons().duplicate({ itemId: lesson.id, courseRevision: course.revision, operatorId: A, now: NOW });
    const first = await lessons().publish({
      itemId: copy.item.id,
      lessonRevision: 1,
      courseRevision: copy.courseRevision,
      reason: 'copy live',
      operatorId: A,
      now: NOW,
    });
    const other = await lessons().publish({
      itemId: lesson.id,
      lessonRevision: 1,
      courseRevision: first.courseRevision,
      reason: 'source live',
      operatorId: A,
      now: NOW,
    });
    await expect(
      lessons().publish({
        itemId: copy.item.id,
        lessonRevision: 1,
        courseRevision: first.courseRevision,
        reason: 'stale tab',
        operatorId: A,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.course_revision_stale' });
    // A subheader duplicates (with no lesson), and a repeat after a lost reply finds that copy.
    const label = await lessons().duplicate({ itemId: subheader.id, courseRevision: other.courseRevision, operatorId: A, now: NOW });
    expect(label.item).toMatchObject({ kind: 'subheader', lessonRevision: null });
    expect(await lessons().duplicate({ itemId: subheader.id, courseRevision: other.courseRevision, operatorId: A, now: LATER })).toEqual(
      label,
    );
    // An item with a lesson does not become a link.
    const detail = await courses().get(course.id);
    const keep = detail.outline[0]!.items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, indent: i.indent, url: i.url }));
    await expect(
      courses().saveOutline({
        courseId: course.id,
        revision: detail.course.revision,
        sections: [
          {
            id: section.id,
            title: 'Start here',
            items: keep.map((i) => (i.id === lesson.id ? { ...i, kind: 'link' as const, url: 'https://example.com' } : i)),
          },
        ],
        operatorId: A,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.item_kind_locked' });
    expect(link.kind).toBe('link');
  });

  it('the live revision is in the read even when 50 newer revisions are saved after it', async () => {
    const { course, lesson } = await draftWithOutline();
    await lessons().save({ itemId: lesson.id, revision: 0, blocks: text('Live'), operatorId: A, now: NOW });
    await lessons().publish({
      itemId: lesson.id,
      lessonRevision: 1,
      courseRevision: course.revision,
      reason: 'go',
      operatorId: A,
      now: NOW,
    });
    for (let r = 1; r <= 51; r++)
      await lessons().save({ itemId: lesson.id, revision: r, blocks: text(`Draft ${r}`), operatorId: A, now: NOW });
    const read = await lessons().get(lesson.id);
    expect(read.revisions).toHaveLength(51);
    expect(read.revisions[0]!.revision).toBe(52);
    expect(read.revisions.at(-1)).toMatchObject({ revision: 1, blocks: text('Live') });
    expect(read.item.liveRevision).toBe(1);
  });
});

describe('lesson import (AC-course-structure-03)', () => {
  const file = (blocks: unknown[]) => JSON.stringify({ format: 'intafaced.lesson.v1', blocks });

  it('a blank size limit refuses; a file over it refuses before it is parsed; nothing is created', async () => {
    const { lesson } = await draftWithOutline();
    await expect(
      new LessonRecords(db.sql, courses()).import({ itemId: lesson.id, revision: 0, document: '{}', operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.import_limit_unset' });
    // Not JSON at all, and over the limit: the size answers first, so the file was never parsed.
    const big = 'x'.repeat(65);
    await expect(
      new LessonRecords(db.sql, courses(), 64).import({ itemId: lesson.id, revision: 0, document: big, operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.import_too_large' });
    expect((await lessons().get(lesson.id)).revisions).toEqual([]);
  });

  it('an unknown block and a bad block are each listed and nothing is created; a good file is a new revision', async () => {
    const { lesson } = await draftWithOutline();
    const importer = new LessonRecords(db.sql, courses(), 8192);
    const bad = await importer.import({
      itemId: lesson.id,
      revision: 0,
      document: file([
        { type: 'text', markdown: 'Fine' },
        { type: 'iframe', src: 'https://example.com' },
        { type: 'image', url: 'javascript:alert(1)', alt: 'x' },
      ]),
      operatorId: A,
      now: NOW,
    });
    expect(bad.outcome).toBe('invalid');
    if (bad.outcome !== 'invalid') throw new Error('unreachable');
    expect(bad.problems.map((p) => p.block)).toEqual([2, 3]);
    expect(bad.problems[0]!.problem).toBe('unknown block type "iframe"');
    expect(bad.lesson.revisions).toEqual([]);
    for (const document of ['not json', JSON.stringify({ format: 'other', blocks: [] })]) {
      const r = await importer.import({ itemId: lesson.id, revision: 0, document, operatorId: A, now: NOW });
      expect(r).toMatchObject({ outcome: 'invalid', problems: [{ block: null }] });
    }
    const good = file([{ type: 'code', language: 'python', source: 'size = risk / stop' }]);
    const done = await importer.import({ itemId: lesson.id, revision: 0, document: good, operatorId: A, now: NOW });
    expect(done.outcome).toBe('imported');
    expect(done.lesson.revisions.map((r) => [r.revision, r.source])).toEqual([[1, 'imported']]);
    expect(await importer.import({ itemId: lesson.id, revision: 0, document: good, operatorId: A, now: LATER })).toEqual(done);
    expect(done.lesson.importMaxBytes).toBe(8192);
  });
});
