import type { ApiResult } from '../../../../shared/api';
import type { Page } from '../schemas';

/**
 * Some lists are an array today and become `{ items, nextCursor }` when their service branch lands. A page reads
 * both, so the day the service changes nothing on screen breaks. An array has no next page.
 */
export function pageOrArray<T>(data: T[] | { items: T[]; nextCursor?: string | null }): Page<T> {
  return Array.isArray(data) ? { items: data, nextCursor: null } : { items: data.items, nextCursor: data.nextCursor ?? null };
}

export function pagedResult<T>(result: ApiResult<T[] | { items: T[]; nextCursor?: string | null }>): ApiResult<Page<T>> {
  return result.ok ? { ok: true, data: pageOrArray(result.data) } : result;
}
