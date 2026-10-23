/**
 * AC-catalogue-01 — owner blanks, card matching and in-course search.
 */
import { describe, expect, it } from 'vitest';
import { browseCatalogue } from './browse.js';
import { CatalogueError } from './errors.js';
import type { CatalogueItem } from './items.js';
import { spineCatalogueItems } from './items.js';
import { assertSearchQuery, catalogueOwnerFromEnv, requireSearchListLimit, SEARCH_QUERY_MAX } from './owner.js';
import { searchEnrolled } from './search.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof CatalogueError ? err.code : 'not-catalogue';
  }
  return undefined;
}

function item(overrides: Partial<CatalogueItem> & Pick<CatalogueItem, 'slug' | 'path'>): CatalogueItem {
  return {
    title: overrides.slug,
    summary: '',
    kind: 'lesson',
    order: 1,
    estimatedMinutes: 5,
    author: null,
    body: '',
    ...overrides,
  };
}

const items: readonly CatalogueItem[] = [
  item({ slug: 'a', path: 'foundations', title: 'Alpha', order: 1, summary: 'first card', body: 'alpha body' }),
  item({ slug: 'a2', path: 'foundations', title: 'Alpine', order: 2, summary: 'second card', body: 'shared phrase here' }),
  item({ slug: 'b', path: 'markets', title: 'Beta', order: 1, summary: 'market card', author: 'Ada Lovelace', body: 'markets only' }),
  item({ slug: 'q', path: 'markets', title: 'Quiz', kind: 'quiz', body: 'shared phrase here' }),
  item({ slug: 's', path: 'builder', title: 'Task', kind: 'assignment', summary: 'alpha body' }),
];

describe('catalogue owner values', () => {
  it('blank, zero and a half-set rate stay unset', () => {
    expect(catalogueOwnerFromEnv({})).toEqual({ searchListLimit: null, publicReadRate: null });
    expect(catalogueOwnerFromEnv({ ACADEMY_SEARCH_LIST_LIMIT: '0', ACADEMY_PUBLIC_READ_RATE_MAX: '8' })).toEqual({
      searchListLimit: null,
      publicReadRate: null,
    });
    expect(catalogueOwnerFromEnv({ ACADEMY_PUBLIC_READ_RATE_MAX: '8', ACADEMY_PUBLIC_READ_RATE_WINDOW_SECONDS: '' })).toEqual({
      searchListLimit: null,
      publicReadRate: null,
    });
  });

  it('reads a published limit and both rate halves', () => {
    expect(
      catalogueOwnerFromEnv({
        ACADEMY_SEARCH_LIST_LIMIT: '25',
        ACADEMY_PUBLIC_READ_RATE_MAX: '8',
        ACADEMY_PUBLIC_READ_RATE_WINDOW_SECONDS: '60',
      }),
    ).toEqual({ searchListLimit: 25, publicReadRate: { max: 8, windowSeconds: 60 } });
  });

  it('refuses a blank search page size and an empty or over-long query', () => {
    expect(code(() => requireSearchListLimit({ searchListLimit: null, publicReadRate: null }))).toBe('academy.search_list_limit_unset');
    expect(code(() => assertSearchQuery('   '))).toBe('academy.search_query_invalid');
    expect(code(() => assertSearchQuery('a'.repeat(SEARCH_QUERY_MAX + 1)))).toBe('academy.search_query_invalid');
    expect(assertSearchQuery('  Risk  ')).toBe('Risk');
  });
});

describe('browseCatalogue', () => {
  it('matches title, summary and author, and drops quiz and assignment items', () => {
    const titles = browseCatalogue({ items, query: 'alpha', sort: 'recommended', limit: 10 }).map((card) => card.slug);
    expect(titles).toEqual(['a']);
    expect(browseCatalogue({ items, query: 'ada', sort: 'recommended', limit: 10 }).map((card) => card.slug)).toEqual(['b']);
    expect(browseCatalogue({ items, query: 'shared phrase', sort: 'recommended', limit: 10 })).toEqual([]);
  });

  it('an unknown category is an empty list, and name sort is by title', () => {
    expect(browseCatalogue({ items, category: 'no-such', sort: 'recommended', limit: 10 })).toEqual([]);
    expect(browseCatalogue({ items, category: 'Foundations', sort: 'name_desc', limit: 10 }).map((card) => card.slug)).toEqual(['a2', 'a']);
  });

  it('progress sort puts a path with completions first and does not invent a ratio for the rest', () => {
    const slugs = browseCatalogue({ items, sort: 'progress', limit: 10, completedSlugs: ['b'] }).map((card) => card.slug);
    expect(slugs).toEqual(['b', 'a', 'a2']);
    const tied = browseCatalogue({ items, sort: 'progress', limit: 10, completedSlugs: ['a', 'a2', 'b'] }).map((card) => card.slug);
    expect(tied).toEqual(['a', 'a2', 'b']);
  });

  it('spine cards are the catalogue fields only', () => {
    const [card] = browseCatalogue({ items: spineCatalogueItems(), sort: 'recommended', limit: 1 });
    expect(Object.keys(card ?? {}).sort()).toEqual(['estimatedMinutes', 'kind', 'order', 'path', 'slug', 'summary', 'title']);
  });
});

describe('searchEnrolled', () => {
  it('returns a body offset for an enrolled path and skips quiz items and other paths', () => {
    const hits = searchEnrolled({ items, query: 'shared phrase', enrolledPaths: ['foundations', 'markets'], limit: 10 });
    expect(hits).toEqual([
      {
        slug: 'a2',
        title: 'Alpine',
        offset: item({ slug: 'a2', path: 'foundations', body: 'shared phrase here' }).body.toLowerCase().indexOf('shared phrase'),
        excerpt: 'shared phrase here',
      },
    ]);
    expect(searchEnrolled({ items, query: 'shared phrase', enrolledPaths: ['builder'], limit: 10 })).toEqual([]);
  });

  it('a title-only hit has a null offset, and an author hit does not invent a body position', () => {
    const title = searchEnrolled({ items, query: 'BETA', enrolledPaths: ['markets'], limit: 10 });
    expect(title).toEqual([{ slug: 'b', title: 'Beta', offset: null, excerpt: 'Beta' }]);
    const author = searchEnrolled({ items, query: 'lovelace', enrolledPaths: ['markets'], limit: 10 });
    expect(author).toEqual([{ slug: 'b', title: 'Beta', offset: null, excerpt: 'Ada Lovelace' }]);
  });

  it('the owner limit caps the hits', () => {
    const hits = searchEnrolled({ items, query: 'a', enrolledPaths: ['foundations', 'markets', 'builder'], limit: 1 });
    expect(hits).toHaveLength(1);
  });
});
