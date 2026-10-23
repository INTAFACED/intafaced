/**
 * AC-catalogue-01 search inside enrolled paths.
 *
 * Title, summary, author and lesson text. Quiz and assignment items are
 * never returned. Offset is the index in the lesson body, or null when the
 * phrase is not in the body (a title or summary hit is not a body position).
 */
import type { CatalogueItem } from './items.js';

/** Characters of body kept on each side of a hit. A wire bound, not an owner setting. */
export const SEARCH_EXCERPT_RADIUS = 48;

export type SearchHit = {
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly offset: number | null;
};

const EXCLUDED_KINDS = new Set(['quiz', 'assignment']);

function fold(value: string): string {
  return value.toLowerCase();
}

function findFolded(haystack: string, needle: string): number {
  return fold(haystack).indexOf(fold(needle));
}

export function excerptAround(text: string, index: number, queryLength: number): string {
  const start = Math.max(0, index - SEARCH_EXCERPT_RADIUS);
  const end = Math.min(text.length, index + queryLength + SEARCH_EXCERPT_RADIUS);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

export function searchEnrolled(input: {
  readonly items: readonly CatalogueItem[];
  readonly query: string;
  readonly enrolledPaths: readonly string[];
  readonly limit: number;
}): SearchHit[] {
  const enrolled = new Set(input.enrolledPaths);
  const hits: SearchHit[] = [];
  for (const item of input.items) {
    if (EXCLUDED_KINDS.has(item.kind)) continue;
    if (!enrolled.has(item.path)) continue;
    const bodyAt = findFolded(item.body, input.query);
    if (bodyAt >= 0) {
      hits.push({
        slug: item.slug,
        title: item.title,
        offset: bodyAt,
        excerpt: excerptAround(item.body, bodyAt, input.query.length),
      });
      continue;
    }
    const titleAt = findFolded(item.title, input.query);
    if (titleAt >= 0) {
      hits.push({ slug: item.slug, title: item.title, offset: null, excerpt: item.title });
      continue;
    }
    const summaryAt = findFolded(item.summary, input.query);
    if (summaryAt >= 0) {
      hits.push({ slug: item.slug, title: item.title, offset: null, excerpt: item.summary });
      continue;
    }
    if (item.author !== null && findFolded(item.author, input.query) >= 0) {
      hits.push({ slug: item.slug, title: item.title, offset: null, excerpt: item.author });
    }
  }
  return hits.slice(0, input.limit);
}
