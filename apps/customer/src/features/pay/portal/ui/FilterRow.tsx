import { useState, type ReactNode } from 'react';
import { Field } from '../../ui-kit';
import { useUrlParam } from '../hooks';
import { SelectField } from '../components';
import { uiCopy } from './copy';

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

/**
 * One slim row: Search, Status, Date (Today, 7d, 30d, custom), Asset and More filters. A filter is shown only when
 * the page passes the options for it, so a list never offers a control its service cannot apply.
 */
export function FilterRow({
  filters,
  statuses,
  assets,
  more,
  shown,
  hasMore,
  total,
  label,
}: {
  filters: ListFilters;
  statuses?: ReadonlyArray<readonly [value: string, label: string]>;
  assets?: readonly string[];
  more?: ReactNode;
  shown?: number;
  hasMore?: boolean;
  total?: number | null;
  label: string;
}) {
  const { t } = uiCopy.useCopy();
  const [open, setOpen] = useState(false);
  const active = Boolean(filters.search || filters.status || filters.date || filters.asset);
  return (
    <div className="pp-filterbar" role="search" aria-label={label}>
      <div className="pp-filter-row">
        <Field label={t('search')} value={filters.search} onChange={(e) => filters.setSearch(e.target.value)} />
        {statuses && (
          <SelectField
            label={t('status')}
            value={filters.status}
            onChange={filters.setStatus}
            options={[['', t('allStatuses')] as const, ...statuses]}
          />
        )}
        <SelectField
          label={t('date')}
          value={filters.date}
          onChange={filters.setDate}
          options={[
            ['', t('anyDate')],
            ['today', t('today')],
            ['7d', t('last7')],
            ['30d', t('last30')],
            ['custom', t('custom')],
          ]}
        />
        {assets && assets.length > 0 && (
          <SelectField
            label={t('asset')}
            value={filters.asset}
            onChange={filters.setAsset}
            options={[['', t('allAssets')] as const, ...assets.map((a) => [a, a] as const)]}
          />
        )}
      </div>
      {filters.date === 'custom' && (
        <div className="pp-filter-row">
          <Field label={t('from')} type="date" value={filters.from} onChange={(e) => filters.setFrom(e.target.value)} />
          <Field label={t('to')} type="date" value={filters.to} onChange={(e) => filters.setTo(e.target.value)} />
        </div>
      )}
      {more && (
        <div>
          <button type="button" className="text-link" aria-expanded={open} onClick={() => setOpen(!open)}>
            {t('moreFilters')}
          </button>
          {open && <div className="pp-filter-row">{more}</div>}
        </div>
      )}
      <p className="muted pp-count" role="status">
        {shown !== undefined ? countText(t, shown, Boolean(hasMore), total) : ''}
        {active && (
          <>
            {' '}
            <button
              type="button"
              className="text-link"
              onClick={() => {
                filters.setSearch('');
                filters.setStatus('');
                filters.setDate('');
                filters.setFrom('');
                filters.setTo('');
                filters.setAsset('');
              }}
            >
              {t('clearFilters')}
            </button>
          </>
        )}
      </p>
    </div>
  );
}
