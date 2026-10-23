import { describe, expect, it } from 'vitest';
import {
  academyLessonBlocksSchema,
  academySaveLessonInputSchema,
  academySaveOutlineInputSchema,
  academyCourseListSchema,
  academyCreateCourseInputSchema,
  academySetCourseStateInputSchema,
  academyUpdateCourseInputSchema,
} from './academy-courses.js';

const free = {
  slug: 'risk-basics',
  title: 'Risk basics',
  summary: null,
  thumbnailUrl: null,
  pricing: 'free',
  price: null,
  priceAsset: null,
};

describe('academy course records (AC-course-structure-01)', () => {
  it('a slug is lower-case words joined by hyphens; an unknown key is refused', () => {
    expect(academyCreateCourseInputSchema.safeParse(free).success).toBe(true);
    for (const slug of ['Risk', 'risk basics', '-risk', 'ri', 'risk--basics'])
      expect(academyCreateCourseInputSchema.safeParse({ ...free, slug }).success).toBe(false);
    expect(academyCreateCourseInputSchema.safeParse({ ...free, state: 'published' }).success).toBe(false);
  });

  it('a paid course may be saved with no price; a price is a positive decimal string with its asset, and a free course has none', () => {
    expect(academyCreateCourseInputSchema.safeParse({ ...free, pricing: 'paid' }).success).toBe(true);
    expect(academyCreateCourseInputSchema.safeParse({ ...free, pricing: 'paid', price: '25.50', priceAsset: 'USDT' }).success).toBe(true);
    expect(academyCreateCourseInputSchema.safeParse({ ...free, pricing: 'paid', price: '25.50', priceAsset: null }).success).toBe(false);
    expect(academyCreateCourseInputSchema.safeParse({ ...free, pricing: 'paid', price: '0.00', priceAsset: 'USDT' }).success).toBe(false);
    expect(academyCreateCourseInputSchema.safeParse({ ...free, pricing: 'paid', price: 25.5, priceAsset: 'USDT' }).success).toBe(false);
    expect(academyCreateCourseInputSchema.safeParse({ ...free, price: '10', priceAsset: 'USDT' }).success).toBe(false);
  });

  it('a thumbnail is an https address or none', () => {
    expect(academyCreateCourseInputSchema.safeParse({ ...free, thumbnailUrl: 'https://cdn.example/t.png' }).success).toBe(true);
    expect(academyCreateCourseInputSchema.safeParse({ ...free, thumbnailUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(academyCreateCourseInputSchema.safeParse({ ...free, thumbnailUrl: 'http://cdn.example/t.png' }).success).toBe(false);
  });

  it('an edit names the revision it was read at and never the slug; a move needs a reason', () => {
    const { slug: _slug, ...rest } = free;
    const id = '11111111-1111-4111-8111-111111111111';
    expect(academyUpdateCourseInputSchema.safeParse({ ...rest, courseId: id, revision: 1 }).success).toBe(true);
    expect(academyUpdateCourseInputSchema.safeParse({ ...free, courseId: id, revision: 1 }).success).toBe(false);
    expect(academySetCourseStateInputSchema.safeParse({ courseId: id, to: 'published', revision: 1, reason: ' ' }).success).toBe(false);
    expect(academySetCourseStateInputSchema.safeParse({ courseId: id, to: 'published', revision: 1, reason: 'ready' }).success).toBe(true);
  });

  it('the list carries a count for every state', () => {
    const counts = { draft: 0, published: 0, concluded: 0, archived: 0, deleted: 0 };
    expect(academyCourseListSchema.safeParse({ courses: [], counts }).success).toBe(true);
    expect(academyCourseListSchema.safeParse({ courses: [], counts: { draft: 0 } }).success).toBe(false);
  });
});

describe('course outline (AC-course-structure-02)', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const item = { kind: 'lesson', title: 'Position size', indent: 0, url: null };
  it('sections of typed items; a link and only a link carries an https address', () => {
    const ok = (items: unknown[]) =>
      academySaveOutlineInputSchema.safeParse({ courseId: id, revision: 1, sections: [{ title: 'S', items }] }).success;
    expect(ok([item, { kind: 'subheader', title: 'Part 1', indent: 0, url: null }])).toBe(true);
    expect(ok([{ kind: 'link', title: 'Docs', indent: 1, url: 'https://example.com' }])).toBe(true);
    expect(ok([{ kind: 'link', title: 'Docs', indent: 0, url: null }])).toBe(false);
    expect(ok([{ ...item, url: 'https://example.com' }])).toBe(false);
    expect(ok([{ ...item, indent: 3 }])).toBe(false);
    expect(ok([{ ...item, kind: 'tool' }])).toBe(false);
  });
});

describe('lesson blocks (AC-course-structure-03)', () => {
  it('text, image, audio, PDF and code blocks; https addresses only; no unknown type or extra field', () => {
    const ok = (blocks: unknown[]) => academyLessonBlocksSchema.safeParse(blocks).success;
    expect(
      ok([
        { type: 'text', markdown: 'Size the position first.' },
        { type: 'image', url: 'https://example.com/a.png', alt: 'A chart' },
        { type: 'audio', url: 'https://example.com/a.ogg', title: 'Walkthrough' },
        { type: 'pdf', url: 'https://example.com/a.pdf', title: 'Handout' },
        { type: 'code', language: 'python', source: 'size = risk / stop' },
      ]),
    ).toBe(true);
    expect(ok([])).toBe(false);
    expect(ok([{ type: 'image', url: 'javascript:alert(1)', alt: 'x' }])).toBe(false);
    expect(ok([{ type: 'pdf', url: 'http://example.com/a.pdf', title: 'x' }])).toBe(false);
    expect(ok([{ type: 'embed', html: '<script></script>' }])).toBe(false);
    expect(ok([{ type: 'text', markdown: 'x', html: '<b>x</b>' }])).toBe(false);
    expect(ok([{ type: 'code', language: 'Py Thon', source: 'x' }])).toBe(false);
  });

  it('a save names the lesson revision it was read at; 0 is nothing written yet', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const blocks = [{ type: 'text', markdown: 'x' }];
    expect(academySaveLessonInputSchema.safeParse({ itemId: id, revision: 0, blocks }).success).toBe(true);
    expect(academySaveLessonInputSchema.safeParse({ itemId: id, revision: -1, blocks }).success).toBe(false);
  });
});
