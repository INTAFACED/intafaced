import { describe, expect, it } from 'vitest';
import {
  ACADEMY_RESERVED_TAB_SLUGS,
  ACADEMY_SLUG_RESERVED_CODE,
  academyRelatedInputSchema,
  academySlugIsReserved,
} from './academy-articles.js';

describe('academy article routing (AC-articles-02)', () => {
  it('reserves every tab slug, case-insensitively', () => {
    for (const slug of ACADEMY_RESERVED_TAB_SLUGS) expect(academySlugIsReserved(slug)).toBe(true);
    expect(academySlugIsReserved('Progress')).toBe(true);
    expect(academySlugIsReserved('risk-basics')).toBe(false);
    expect(ACADEMY_SLUG_RESERVED_CODE).toBe('academy.slug_reserved');
  });
  it('related input needs a slug and a positive integer limit when given', () => {
    expect(academyRelatedInputSchema.safeParse({ slug: 'risk-basics' }).success).toBe(true);
    expect(academyRelatedInputSchema.safeParse({ slug: 'risk-basics', limit: 3 }).success).toBe(true);
    for (const bad of [{ slug: '' }, { slug: 'a', limit: 0 }, { slug: 'a', limit: 2.5 }, { slug: 'a', extra: 1 }])
      expect(academyRelatedInputSchema.safeParse(bad).success).toBe(false);
  });
});
