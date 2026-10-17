import { useCursorList } from '../hooks';
import type { ApiResult } from '../../../../shared/api';
import { pagedResult } from './page';

/**
 * A list the server pages and filters. The filters are the page's own (kept in the URL by `FilterRow`); when any
 * of them changes the list starts again from the first page. The cursor is the server's, passed back exactly as
 * received. A read that returns an array or a page both work (`pageOrArray`). There is no sort control here: a
 * list is "newest first" until its service can sort.
 */
export function useServerList<T, F extends Record<string, string>>(
  read: (
    filters: F,
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<ApiResult<T[] | { items: T[]; nextCursor?: string | null }>>,
  filters: F,
  identity: (item: T) => string,
) {
  const key = JSON.stringify(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)));
  return useCursorList<T>(async (cursor, signal) => pagedResult(await read(filters, cursor, signal)), key, identity);
}
