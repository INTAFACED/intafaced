import { useMemo } from 'react';
import { dateRange, type ListFilters } from '../ui/FilterRow';
import type { ListQuery } from './api';

/** The service's view of the filter row: blank is left out, and the date choice becomes real bounds. */
export function useListQuery(filters: ListFilters, extra: ListQuery = {}): ListQuery & Record<string, string> {
  const { date, from, to, status, asset, search } = filters;
  return useMemo(() => {
    const range = dateRange(date, Date.now(), { from, to });
    return {
      ...(status ? { status } : {}),
      ...(asset ? { assetId: asset } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(range.from ? { from: range.from } : {}),
      ...(range.to ? { to: range.to } : {}),
      ...extra,
    } as ListQuery & Record<string, string>;
    // `extra` is built fresh each render by callers; its values are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, from, to, status, asset, search, JSON.stringify(extra)]);
}
