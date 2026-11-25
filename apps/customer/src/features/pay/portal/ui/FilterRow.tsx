import { useUrlParam } from '../hooks';
import type { uiCopy } from './copy';

export type DatePreset = '' | 'today' | '7d' | '30d' | 'custom';
const DAY = 86_400_000;
const startOfUtcDay = (ms: number) => new Date(Math.floor(ms / DAY) * DAY).toISOString();

/** The window a date choice means, as ISO bounds. `to` is exclusive; an open end is left out so the server applies none. */
export function dateRange(
  preset: DatePreset,
  now: number,
  custom: { from: string; to: string } = { from: '', to: '' },
): { from?: string; to?: string } {
  if (preset === 'today') return { from: startOfUtcDay(now), to: startOfUtcDay(now + DAY) };
  if (preset === '7d') return { from: startOfUtcDay(now - 6 * DAY), to: startOfUtcDay(now + DAY) };
  if (preset === '30d') return { from: startOfUtcDay(now - 29 * DAY), to: startOfUtcDay(now + DAY) };
  if (preset === 'custom') {
    const from = custom.from ? `${custom.from}T00:00:00.000Z` : undefined;
    const to = custom.to ? startOfUtcDay(Date.parse(`${custom.to}T00:00:00.000Z`) + DAY) : undefined;
    return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  }
  return {};
}

/** All filter state lives in the address, so a filtered view can be shared and survives a reload. */
export function useListFilters() {
  const [search, setSearch] = useUrlParam('q');
  const [status, setStatus] = useUrlParam('status');
  const [date, setDate] = useUrlParam('date');
  const [from, setFrom] = useUrlParam('from');
  const [to, setTo] = useUrlParam('to');
  const [asset, setAsset] = useUrlParam('asset');
  return { search, setSearch, status, setStatus, date: date as DatePreset, setDate, from, setFrom, to, setTo, asset, setAsset };
}
export type ListFilters = ReturnType<typeof useListFilters>;

/** The honest count: "N results" only when the server gave a total, otherwise "Newest N" (with "· Load more" while another page exists). */
export function countText(t: ReturnType<typeof uiCopy.useCopy>['t'], shown: number, hasMore: boolean, total?: number | null): string {
  if (typeof total === 'number') return t('resultsExact', { n: total });
  return hasMore ? t('newestMore', { n: shown }) : t('newestShown', { n: shown });
}
