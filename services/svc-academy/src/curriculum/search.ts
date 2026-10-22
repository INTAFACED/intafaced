/**
 * AC-catalogue-01 / AC-articles-02 — catalogue query, in-course search,
 * related items and the reserved tab-slug check over the shipped curriculum.
 *
 * Until courses are rows (AC-course-structure-01) the `recommended` order is
 * the order of the shipped list. No external search service: plain
 * case-folded substring matching over our own text.
 */
import { AcademyError } from '../errors.js';
import { getCurriculumItem, listCurriculum, type CurriculumItemSummary, type CurriculumKind, type CurriculumPath } from './catalog.js';

export { RESERVED_TAB_SLUGS, assertSlugNotReserved, assertNoReservedSlugs } from './reserved-slugs.js';

export const SEARCH_QUERY_MAX = 120;
export type CatalogueSort = 'recommended' | 'name_asc' | 'name_desc';

export function normaliseQuery(q: string): string {
  const n = q.trim().toLowerCase();
  if (n === '' || n.length > SEARCH_QUERY_MAX) {
    throw new AcademyError(`search query must be 1-${SEARCH_QUERY_MAX} characters`, 'academy.search_query_invalid');
  }
  return n;
}

export function queryCatalogue(input: {
  path?: CurriculumPath;
  kind?: CurriculumKind;
  q?: string;
  sort?: CatalogueSort;
}): CurriculumItemSummary[] {
  let items = listCurriculum({
    ...(input.path ? { path: input.path } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
  });
  if (input.q !== undefined) {
    const n = normaliseQuery(input.q);
    items = items.filter((i) => i.title.toLowerCase().includes(n) || i.summary.toLowerCase().includes(n));
  }
  if (input.sort === 'name_asc') items = [...items].sort((a, b) => a.title.localeCompare(b.title));
  if (input.sort === 'name_desc') items = [...items].sort((a, b) => b.title.localeCompare(a.title));
  return items;
}

export interface SearchHit {
  slug: string;
  title: string;
  path: CurriculumPath;
  /** Where the match is: title, summary or body. */
  field: 'title' | 'summary' | 'body';
  /** Character offset of the match inside that field. */
  offset: number;
  excerpt: string;
}

const EXCERPT_RADIUS = 60;

function excerptAt(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - EXCERPT_RADIUS);
  const end = Math.min(text.length, offset + length + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Search title, summary and lesson text inside the given (enrolled) paths.
 * Workbooks are the exercise items (quiz and assignment class) and are
 * excluded so a search never surfaces an exercise's answers.
 */
export function searchEnrolled(paths: readonly CurriculumPath[], q: string, limit: number): SearchHit[] {
  const n = normaliseQuery(q);
  const allowed = new Set(paths);
  const hits: SearchHit[] = [];
  for (const summary of listCurriculum()) {
    if (!allowed.has(summary.path) || summary.kind === 'workbook') continue;
    const item = getCurriculumItem(summary.slug);
    if (!item) continue;
    for (const field of ['title', 'summary', 'body'] as const) {
      const text = item[field];
      const offset = text.toLowerCase().indexOf(n);
      if (offset >= 0) {
        hits.push({ slug: item.slug, title: item.title, path: item.path, field, offset, excerpt: excerptAt(text, offset, n.length) });
        break;
      }
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Related items: same path, excluding the item itself, in shipped order. None → []. */
export function relatedItems(slug: string, limit: number): CurriculumItemSummary[] {
  const item = getCurriculumItem(slug);
  if (!item) throw new AcademyError(`Curriculum item "${slug}" is not in the day-one spine`, 'academy.curriculum_not_found');
  return listCurriculum({ path: item.path })
    .filter((i) => i.slug !== slug)
    .slice(0, limit);
}
