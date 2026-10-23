/**
 * AC-catalogue-01 browse: title, author and summary match, then a sort.
 * Lesson text is not matched here. That is `search.ts`.
 */
import type { CatalogueCard, CatalogueItem } from './items.js';
import { toCard } from './items.js';

export type CatalogueSort = 'progress' | 'name_asc' | 'name_desc' | 'recommended';

export type BrowseInput = {
  readonly items: readonly CatalogueItem[];
  readonly query?: string;
  readonly category?: string;
  readonly kind?: string;
  readonly sort: CatalogueSort;
  readonly limit: number;
  /** Used only for `progress`. Omitted means no learner data (the public read). */
  readonly completedSlugs?: readonly string[];
};

function fold(value: string): string {
  return value.toLowerCase();
}

function matchesQuery(item: CatalogueItem, query: string): boolean {
  const needle = fold(query);
  if (fold(item.title).includes(needle)) return true;
  if (fold(item.summary).includes(needle)) return true;
  return item.author !== null && fold(item.author).includes(needle);
}

function shipped(a: CatalogueItem, b: CatalogueItem): number {
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  if (a.order !== b.order) return a.order - b.order;
  return a.slug.localeCompare(b.slug);
}

function pathRatio(path: string, items: readonly CatalogueItem[], completed: ReadonlySet<string>): { done: number; total: number } | null {
  const onPath = items.filter((item) => item.path === path && item.kind !== 'quiz' && item.kind !== 'assignment');
  if (onPath.length === 0) return null;
  const done = onPath.filter((item) => completed.has(item.slug)).length;
  if (done === 0) return null;
  return { done, total: onPath.length };
}

function byProgress(items: readonly CatalogueItem[], completed: ReadonlySet<string>): (a: CatalogueItem, b: CatalogueItem) => number {
  return (a, b) => {
    const left = pathRatio(a.path, items, completed);
    const right = pathRatio(b.path, items, completed);
    if (left === null && right === null) return shipped(a, b);
    if (left === null) return 1;
    if (right === null) return -1;
    const cross = left.done * right.total - right.done * left.total;
    if (cross !== 0) return cross > 0 ? -1 : 1;
    return shipped(a, b);
  };
}

function byName(dir: 1 | -1): (a: CatalogueItem, b: CatalogueItem) => number {
  return (a, b) => {
    const byTitle = fold(a.title).localeCompare(fold(b.title));
    if (byTitle !== 0) return dir * byTitle;
    return a.slug.localeCompare(b.slug);
  };
}

/** Cards only. No body, no author, no progress figure. */
export function browseCatalogue(input: BrowseInput): CatalogueCard[] {
  const category = input.category?.trim().toLowerCase() ?? '';
  const query = input.query?.trim() ?? '';
  const matched = input.items.filter((item) => {
    if (item.kind === 'quiz' || item.kind === 'assignment') return false;
    if (category && item.path !== category) return false;
    if (input.kind && item.kind !== input.kind) return false;
    if (query && !matchesQuery(item, query)) return false;
    return true;
  });
  const completed = new Set(input.completedSlugs ?? []);
  const ordered = matched.slice().sort((a, b) => {
    if (input.sort === 'name_asc') return byName(1)(a, b);
    if (input.sort === 'name_desc') return byName(-1)(a, b);
    if (input.sort === 'progress') return byProgress(input.items, completed)(a, b);
    return shipped(a, b);
  });
  return ordered.slice(0, input.limit).map(toCard);
}
