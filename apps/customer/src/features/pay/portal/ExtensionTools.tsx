import { useState, type ReactNode } from 'react';
import { StatusTag, Button } from '@intafaced/ui';
import { Field } from '../ui-kit';
import { PayTime } from '../components';
import { useNow, useUrlParam } from './hooks';
import { buildCsv, downloadText } from './csv';
import { NotLive, SelectField } from './components';
import { extensionCopy as c } from './extension-copy';

export function Arrives({ reason, children }: { reason: string; children: ReactNode }) {
  return <NotLive reason={reason}>{children}</NotLive>;
}
export function PortalBack({ href = '/pay/merchant', children }: { href?: string; children?: ReactNode }) {
  return (
    <a className="text-link" href={href}>
      {children ?? c.t('backHome')}
    </a>
  );
}
export { CopyReference } from './ui/CopyReference';

// Keep list-window affordances shared across the extension pages.

export function ReadStamp({ at }: { at: string | null }) {
  const now = useNow();
  if (!at) return null;
  return (
    <div className="pp-asof" role="status">
      <span>
        {c.t('readAt')} <PayTime value={at} />
      </span>
      {now - Date.parse(at) > 300_000 && <p className="pp-callout pp-callout--warn">{c.t('staleRead')}</p>}
    </div>
  );
}
export function WindowExport({ headers, rows, at, name }: { headers: string[]; rows: unknown[][]; at: string | null; name: string }) {
  return (
    <Button
      variant="secondary"
      disabled={!at || !rows.length}
      onClick={() => {
        if (at) downloadText(`${name}.csv`, buildCsv(headers, rows, { generatedAt: new Date().toISOString(), asOf: at }));
      }}
    >
      {c.t('exportShown')}
    </Button>
  );
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
