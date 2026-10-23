/**
 * AC-catalogue-01 owner values.
 *
 * Blank is null. Nothing here invents a page size or a rate. The settings
 * register and `env.ts` are owned by the open AC-videos-01 pull request, so
 * these are read from the process environment at boot and refused by name
 * when blank.
 */
import { ACADEMY_CUSTOMER_LIST_MAX } from '../learning/limits.js';
import { CatalogueError } from './errors.js';

/** Wire bound for `academy.search_query_invalid`. Not an owner page size. */
export const SEARCH_QUERY_MAX = 200;

export type PublicReadRate = {
  readonly max: number;
  readonly windowSeconds: number;
};

export type CatalogueOwner = {
  /** How many in-course search hits one read may return. Null refuses. */
  readonly searchListLimit: number | null;
  /** Signed-out catalogue rate. Null when either half is blank. */
  readonly publicReadRate: PublicReadRate | null;
};

/**
 * A positive integer with no leading zero. Blank, zero, fractions and
 * scientific notation are unpublished.
 */
function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

export function catalogueOwnerFromEnv(env: NodeJS.ProcessEnv): CatalogueOwner {
  const max = positiveInt(env.ACADEMY_PUBLIC_READ_RATE_MAX);
  const windowSeconds = positiveInt(env.ACADEMY_PUBLIC_READ_RATE_WINDOW_SECONDS);
  return {
    searchListLimit: positiveInt(env.ACADEMY_SEARCH_LIST_LIMIT),
    publicReadRate: max !== null && windowSeconds !== null ? { max, windowSeconds } : null,
  };
}

/**
 * The published search page size. Blank refuses. A larger published value is
 * cut to the same dump ceiling as the other customer lists. That ceiling is
 * not a page size and is not used when the owner value is blank.
 */
export function requireSearchListLimit(owner: CatalogueOwner): number {
  if (owner.searchListLimit === null) {
    throw new CatalogueError('academy.search_list_limit_unset', 'academy.search_list_limit_unset');
  }
  return Math.min(owner.searchListLimit, ACADEMY_CUSTOMER_LIST_MAX);
}

export function assertSearchQuery(raw: string | undefined): string {
  const query = (raw ?? '').trim();
  if (query.length < 1 || query.length > SEARCH_QUERY_MAX) {
    throw new CatalogueError('academy.search_query_invalid', 'academy.search_query_invalid');
  }
  return query;
}
