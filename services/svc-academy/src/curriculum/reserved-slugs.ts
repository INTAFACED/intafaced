/** AC-articles-02 — reserved academy tab slugs (IA-SPEC 2.9). */
import { ACADEMY_RESERVED_TAB_SLUGS, academySlugIsReserved } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';

/** IA-SPEC 2.9 tab slugs: never a lesson, course, topic or item slug. */
/** Owned by packages/contracts (academy-articles.ts) so clients share the list. */
export const RESERVED_TAB_SLUGS: readonly string[] = ACADEMY_RESERVED_TAB_SLUGS;

export function assertSlugNotReserved(slug: string): void {
  // Contracts check trims and lower-cases, so 'Rooms' and ' rooms ' are reserved too.
  if (academySlugIsReserved(slug)) {
    throw new AcademyError(`slug "${slug}" is a reserved academy tab`, 'academy.slug_reserved');
  }
}

/** Start-up check: refuses to load when a shipped slug collides, and names it. */
export function assertNoReservedSlugs(slugs: readonly string[]): void {
  for (const slug of slugs) assertSlugNotReserved(slug);
}
