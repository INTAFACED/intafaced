/**
 * AC-catalogue-01 — the signed-out catalogue: the published spine, filtered and sorted, with no learner data.
 *
 * Until courses are rows (AC-course-structure-01) the shipped list order is the `recommended` order. A query
 * matches title and summary, case-folded; an empty query matches everything. No search service is involved.
 */
import type { AcademyPublicCatalogueSort as PublicCatalogueSort } from '@intafaced/contracts';
import { listCurriculum, type CurriculumItemSummary, type CurriculumKind, type CurriculumPath } from './catalog.js';

export function searchPublicCurriculum(input: {
  readonly q?: string;
  readonly path?: CurriculumPath;
  readonly kind?: CurriculumKind;
  readonly sort?: PublicCatalogueSort;
  readonly limit: number;
}): CurriculumItemSummary[] {
  const needle = (input.q ?? '').trim().toLocaleLowerCase('en');
  const rows = listCurriculum({
    ...(input.path ? { path: input.path } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
  }).filter((row) => !needle || row.title.toLocaleLowerCase('en').includes(needle) || row.summary.toLocaleLowerCase('en').includes(needle));
  const sort = input.sort ?? 'recommended';
  if (sort !== 'recommended') {
    rows.sort((a, b) => a.title.localeCompare(b.title, 'en') || a.slug.localeCompare(b.slug));
    if (sort === 'name_desc') rows.reverse();
  }
  return rows.slice(0, input.limit);
}
