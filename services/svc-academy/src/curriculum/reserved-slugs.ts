/** AC-articles-02 — reserved academy tab slugs (IA-SPEC 2.9). */
import { AcademyError } from '../errors.js';

/** IA-SPEC 2.9 tab slugs: never a lesson, course, topic or item slug. */
export const RESERVED_TAB_SLUGS: readonly string[] = ['learning', 'certificates', 'rooms', 'videos', 'programmes', 'progress'];

export function assertSlugNotReserved(slug: string): void {
  if (RESERVED_TAB_SLUGS.includes(slug)) {
    throw new AcademyError(`slug "${slug}" is a reserved academy tab`, 'academy.slug_reserved');
  }
}

/** Start-up check: refuses to load when a shipped slug collides, and names it. */
export function assertNoReservedSlugs(slugs: readonly string[]): void {
  for (const slug of slugs) assertSlugNotReserved(slug);
}
