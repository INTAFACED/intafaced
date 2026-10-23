import { describe, expect, it } from 'vitest';
import {
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
