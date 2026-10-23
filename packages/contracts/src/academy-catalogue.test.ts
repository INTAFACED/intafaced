import { describe, expect, it } from 'vitest';
import { academyCurriculumSummarySchema, academyPublicCatalogueInputSchema, academyPublicItemSchema } from './academy-catalogue.js';

const row = { slug: 's', title: 'T', kind: 'lesson', path: 'markets', order: 1, summary: '', estimatedMinutes: 2 };

describe('academy signed-out catalogue shapes (AC-catalogue-01)', () => {
  it('carries no learner field and refuses an unknown key on the input', () => {
    expect(academyCurriculumSummarySchema.parse(row)).toEqual(row);
    expect(academyPublicItemSchema.safeParse({ ...row, body: 'b', objectives: [], keyTerms: [], selfCheck: [] }).success).toBe(true);
    expect(academyPublicCatalogueInputSchema.safeParse({ q: 'risk', sort: 'name_desc', limit: 5 }).success).toBe(true);
    expect(academyPublicCatalogueInputSchema.safeParse({ userId: 'x', limit: 5 }).success).toBe(false);
    expect(academyPublicCatalogueInputSchema.safeParse({ sort: 'popular', limit: 5 }).success).toBe(false);
  });
});
