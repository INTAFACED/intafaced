import { type ReactNode } from 'react';
import { StatusTag } from '@intafaced/ui';
import { Field } from '../ui-kit';
import { useUrlParam } from './hooks';
import { NotLive, SelectField } from './components';
import { extensionCopy as c } from './extension-copy';

export function Arrives({ reason, children }: { reason: string; children: ReactNode }) {
  return <NotLive reason={reason}>{children}</NotLive>;
}
export const recordStates = ['active', 'revoked', 'disabled', 'pending', 'delivered', 'failed', 'dead'] as const;
export type RecordStatus = (typeof recordStates)[number];
export function RecordChip({ status }: { status: RecordStatus }) {
  return (
    <StatusTag
      status={status === 'active' || status === 'delivered' ? 'filled' : status === 'failed' || status === 'dead' ? 'failed' : 'working'}
      title={c.t(`${status}Tip`)}
      label={c.t(status)}
    />
  );
}
export function useWindowFilters() {
  const [search, setSearch] = useUrlParam('search');
  const [status, setStatus] = useUrlParam('status');
  const [sort, setSort] = useUrlParam('sort', 'newest');
  return { search, setSearch, status, setStatus, sort, setSort };
}
export function WindowFilters({ filters, statuses }: { filters: ReturnType<typeof useWindowFilters>; statuses: readonly RecordStatus[] }) {
  return (
    <div className="pp-filter-row" role="search" aria-label={c.t('search')}>
      <Field label={c.t('search')} value={filters.search} onChange={(e) => filters.setSearch(e.target.value)} />
      <SelectField
        label={c.t('status')}
        value={filters.status}
        onChange={filters.setStatus}
        options={[['', c.t('all')] as const, ...statuses.map((status) => [status, c.t(status)] as const)]}
      />
      <SelectField
        label={c.t('sort')}
        value={filters.sort}
        onChange={filters.setSort}
        options={[['newest', c.t('newest')] as const, ['oldest', c.t('oldest')] as const, ['name', c.t('nameSort')] as const]}
      />
    </div>
  );
}
/** Endpoint metadata can contain URL query credentials. Lists and exports omit all URL credentials/query/fragment. */
export function safeEndpointUrl(raw: string) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}${url.search ? '?…' : ''}`;
  } catch {
    return '—';
  }
}
