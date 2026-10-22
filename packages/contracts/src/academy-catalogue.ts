import { z } from 'zod';

/**
 * AC-catalogue-01: academy curriculum catalogue and search shapes, owned by svc-academy. No learner data.
 * The search page size and the public read rate are owner settings, never inputs or defaults: unset refuses with
 * `academy.search_list_limit_unset` / `academy.public_read_rate_unset`.
 */
export const ACADEMY_SEARCH_QUERY_MAX = 120;
export const academyCurriculumPathSchema = z.enum(['foundations', 'markets', 'builder', 'sovereign']);
export type AcademyCurriculumPath = z.infer<typeof academyCurriculumPathSchema>;
export const academyCurriculumKindSchema = z.enum(['playbook', 'workbook', 'lesson']);
export type AcademyCurriculumKind = z.infer<typeof academyCurriculumKindSchema>;
export const academyCatalogueSortSchema = z.enum(['recommended', 'progress', 'name_asc', 'name_desc']);
/** `progress` needs a signed-in learner; the service refuses it for a signed-out caller. */

/** Input of `curriculum` and `publicCatalogue`. */
export const academyCatalogueQuerySchema = z
  .object({
    path: academyCurriculumPathSchema.optional(),
    kind: academyCurriculumKindSchema.optional(),
    q: z.string().max(ACADEMY_SEARCH_QUERY_MAX).optional(),
    category: z.string().min(1).max(96).optional(),
    sort: academyCatalogueSortSchema.optional(),
    limit: z.number().int().positive().safe().optional(),
  })
  .strict()
  .optional();
export type AcademyCatalogueQuery = z.infer<typeof academyCatalogueQuerySchema>;

/** Output row of `curriculum` / `publicCatalogue`. `estimatedMinutes` is derived from the body, never hand-typed. */
export const academyCurriculumSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: academyCurriculumKindSchema,
  path: academyCurriculumPathSchema,
  order: z.number().int(),
  summary: z.string(),
  /** Shown only when the course has one; null otherwise, never invented. */
  author: z.string().nullable(),
  estimatedMinutes: z.number().int().positive(),
});
export type AcademyCurriculumSummary = z.infer<typeof academyCurriculumSummarySchema>;

/** `search` input; the page size is the owner setting, not an input. */
export const academySearchInputSchema = z.object({ q: z.string().max(ACADEMY_SEARCH_QUERY_MAX) }).strict();
export const academySearchHitSchema = z.object({
  slug: z.string(),
  title: z.string(),
  path: academyCurriculumPathSchema,
  field: z.enum(['title', 'summary', 'body']),
  offset: z.number().int().nonnegative(),
  excerpt: z.string(),
});
export type AcademySearchHit = z.infer<typeof academySearchHitSchema>;

export const ACADEMY_CATALOGUE_REFUSAL_CODES = [
  'academy.search_query_invalid',
  'academy.search_list_limit_unset',
  'academy.public_read_rate_unset',
  'academy.public_read_rate_limited',
] as const;
export type AcademyCatalogueRefusalCode = (typeof ACADEMY_CATALOGUE_REFUSAL_CODES)[number];
