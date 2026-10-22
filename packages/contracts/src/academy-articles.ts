import { z } from 'zod';

/**
 * AC-articles-02: academy article routing shapes, owned by svc-academy.
 * IA-SPEC 2.9: the academy tab slugs are reserved and are never a lesson, course, topic or item slug.
 * `curriculumRelated` (spec name `academy.related`) returns curriculum summary rows (the AC-catalogue-01 summary shape).
 */
export const ACADEMY_RESERVED_TAB_SLUGS = ['learning', 'certificates', 'rooms', 'videos', 'programmes', 'progress'] as const;
export const ACADEMY_SLUG_RESERVED_CODE = 'academy.slug_reserved' as const;

export function academySlugIsReserved(slug: string): boolean {
  return (ACADEMY_RESERVED_TAB_SLUGS as readonly string[]).includes(slug.trim().toLowerCase());
}

/** `curriculumRelated` input. The list size is the service's owner setting; a given limit is a positive integer. */
export const academyRelatedInputSchema = z
  .object({ slug: z.string().min(1).max(120), limit: z.number().int().positive().safe().optional() })
  .strict();
export type AcademyRelatedInput = z.infer<typeof academyRelatedInputSchema>;
