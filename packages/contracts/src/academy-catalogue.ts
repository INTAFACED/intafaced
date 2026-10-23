import { z } from 'zod';

/**
 * AC-catalogue-01: the signed-out Academy, owned by svc-academy. A visitor with no account reads the published
 * catalogue, one item and its related items, and the video list; no learner data is in any of these shapes.
 * Per-address limits on these reads are svc-edge's, the one hop that sees the caller's address.
 */
export const ACADEMY_CURRICULUM_PATHS = ['foundations', 'markets', 'builder', 'sovereign'] as const;
export const ACADEMY_CURRICULUM_KINDS = ['playbook', 'workbook', 'lesson'] as const;
/** `recommended` is the shipped list order until courses are rows (AC-course-structure-01). */
export const ACADEMY_PUBLIC_CATALOGUE_SORTS = ['recommended', 'name_asc', 'name_desc'] as const;
export type AcademyPublicCatalogueSort = (typeof ACADEMY_PUBLIC_CATALOGUE_SORTS)[number];

export const academyCurriculumSummarySchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(ACADEMY_CURRICULUM_KINDS),
  path: z.enum(ACADEMY_CURRICULUM_PATHS),
  order: z.number().int(),
  summary: z.string(),
  /** Derived from the body, never hand-typed. */
  estimatedMinutes: z.number().int().positive(),
});
export type AcademyCurriculumSummary = z.infer<typeof academyCurriculumSummarySchema>;

/** `publicCurriculum` input. `q` matches title and summary, case-folded. The page size is the caller's to send. */
export const academyPublicCatalogueInputSchema = z
  .object({
    q: z.string().max(120).optional(),
    path: z.enum(ACADEMY_CURRICULUM_PATHS).optional(),
    kind: z.enum(ACADEMY_CURRICULUM_KINDS).optional(),
    sort: z.enum(ACADEMY_PUBLIC_CATALOGUE_SORTS).optional(),
    limit: z.number().optional(),
  })
  .strict();
export type AcademyPublicCatalogueInput = z.infer<typeof academyPublicCatalogueInputSchema>;

/** `publicCurriculumItem`: the reader's item, with its teaching scaffolding and no learner state. */
export const academyPublicItemSchema = academyCurriculumSummarySchema.extend({
  body: z.string(),
  objectives: z.array(z.string()),
  keyTerms: z.array(z.object({ term: z.string(), definition: z.string() })),
  selfCheck: z.array(z.string()),
});
export type AcademyPublicItem = z.infer<typeof academyPublicItemSchema>;

/** `publicVideos`: titles only; playback stays behind sign-in and the tier and stake gate. */
export const academyPublicVideoSchema = z.object({ slug: z.string(), title: z.string(), path: z.enum(ACADEMY_CURRICULUM_PATHS) });
export type AcademyPublicVideo = z.infer<typeof academyPublicVideoSchema>;
