import { describe, expect, it } from 'vitest';
import {
  ACADEMY_CATALOGUE_REFUSAL_CODES,
  ACADEMY_SEARCH_QUERY_MAX,
  academyCatalogueQuerySchema,
  academyCurriculumSummarySchema,
  academySearchHitSchema,
  academySearchInputSchema,
} from './academy-catalogue.js';

describe('academy catalogue contracts (AC-catalogue-01)', () => {
  it('query is optional and filters by path, kind, text and sort', () => {
    expect(academyCatalogueQuerySchema.safeParse(undefined).success).toBe(true);
    expect(academyCatalogueQuerySchema.safeParse({ path: 'markets', kind: 'lesson', q: 'risk', sort: 'name_asc', limit: 20 }).success).toBe(
      true,
    );
    for (const bad of [
      { path: 'other' },
      { sort: 'progress' },
      { q: 'x'.repeat(ACADEMY_SEARCH_QUERY_MAX + 1) },
      { limit: 0 },
      { limit: 1.5 },
      { learnerId: 'x' },
    ])
      expect(academyCatalogueQuerySchema.safeParse(bad).success).toBe(false);
  });
  it('summary row needs positive derived minutes', () => {
    const row = { slug: 'a', title: 'A', kind: 'playbook', path: 'foundations', order: 1, summary: 's', estimatedMinutes: 5 };
    expect(academyCurriculumSummarySchema.safeParse(row).success).toBe(true);
    expect(academyCurriculumSummarySchema.safeParse({ ...row, estimatedMinutes: 0 }).success).toBe(false);
  });
  it('search input has no page size; hits name the matched field', () => {
    expect(academySearchInputSchema.safeParse({ q: 'risk' }).success).toBe(true);
    expect(academySearchInputSchema.safeParse({ q: 'risk', limit: 50 }).success).toBe(false);
    const hit = { slug: 'a', title: 'A', path: 'builder', field: 'body', offset: 3, excerpt: '…risk…' };
    expect(academySearchHitSchema.safeParse(hit).success).toBe(true);
    expect(academySearchHitSchema.safeParse({ ...hit, field: 'tags' }).success).toBe(false);
    expect(academySearchHitSchema.safeParse({ ...hit, offset: -1 }).success).toBe(false);
  });
  it('declares the refusal codes', () => {
    expect(ACADEMY_CATALOGUE_REFUSAL_CODES).toContain('academy.search_list_limit_unset');
  });
});
