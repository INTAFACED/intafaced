'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  sortRows,
  Table,
  type SortState,
  type TableColumn,
} from '@intafaced/ui';
import {
  clockUtc,
  filterMarkets,
  lifecycleOf,
  NO_FILTER,
  seededPercent,
  type MarketFilter,
  type MarketRowView,
} from '@/lib/trade-ops/markets-model';
import { LifecycleBadge, RecordStatusBadge } from './markets-lifecycle-badge';

/**
 * The markets list: every market with its rules, its record status and lifecycle state, and how many orders rest on it.
 * Filter by status and kind, search by symbol, sort any column (decimals compare exactly). A row opens the market.
 * "—" means not known; it is never drawn as zero.
 */

const STATUS_ITEMS = { all: 'All statuses', active: 'Active', pending: 'Pending', halted: 'Halted', delisted: 'Delisted' };
const KIND_ITEMS = { all: 'All kinds', spot: 'Spot', futures: 'Futures', options: 'Options' };

const columns: readonly TableColumn<MarketRowView>[] = [
  { id: 'symbol', header: 'Symbol', value: (r) => r.market.symbol, sortable: true, pin: 'start', width: 120 },
  { id: 'kind', header: 'Kind', value: (r) => r.market.kind, sortable: true, width: 70 },
  {
    id: 'status',
    header: 'Record status',
    cell: (r) => <RecordStatusBadge status={r.market.status} />,
    sortValue: (r) => r.market.status,
    sortable: true,
    width: 140,
  },
  {
    id: 'lifecycle',
    header: 'Lifecycle',
    cell: (r) => <LifecycleBadge lifecycle={r.lifecycle} />,
    sortValue: (r) => lifecycleOf(r)?.state ?? null,
    sortable: true,
    width: 130,
  },
  {
    id: 'actions',
    header: 'Actions',
    headerLabel: 'Allowed actions',
    numeric: true,
    value: (r) => {
      const l = lifecycleOf(r);
      return l ? String(l.allowedActions.length) : null;
    },
    sortable: true,
    width: 100,
  },
  { id: 'tick', header: 'Tick', numeric: true, width: 120, value: (r) => r.market.tickSize, sortable: true },
  { id: 'lot', header: 'Lot', numeric: true, width: 120, value: (r) => r.market.lotSize, sortable: true },
  { id: 'minQty', header: 'Min qty', numeric: true, width: 120, value: (r) => r.market.minQty, sortable: true },
  { id: 'minNotional', header: 'Min notional', numeric: true, width: 140, value: (r) => r.market.minNotional, sortable: true },
  {
    id: 'fees',
    header: 'Maker / taker bps',
    numeric: true,
    sortable: true,
    sortValue: (r) => String(r.market.makerBps),
    cell: (r) => `${r.market.makerBps} / ${r.market.takerBps}`,
    width: 160,
  },
  {
    id: 'open',
    header: 'Open orders',
    numeric: true,
    sortable: true,
    value: (r) => (r.orders ? String(r.orders.open) : null),
    cell: (r) => (r.orders ? (r.orders.held > 0 ? `${r.orders.open} (${r.orders.held} held)` : String(r.orders.open)) : '—'),
    width: 130,
  },
  {
    id: 'seeded',
    header: 'Seeded',
    numeric: true,
    sortable: true,
    value: (r) => {
      const p = seededPercent(r.orders);
      return p === null ? null : String(p);
    },
    cell: (r) => {
      const p = seededPercent(r.orders);
      return p === null ? '—' : `${p}%`;
    },
    width: 90,
  },
  {
    id: 'asOf',
    header: 'As of',
    cell: (r) => clockUtc(r.lifecycle?.asOf ?? null),
    value: (r) => r.lifecycle?.asOf ?? null,
    sortable: true,
    width: 130,
  },
];

export function MarketsTable({ rows }: { rows: readonly MarketRowView[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<MarketFilter>(NO_FILTER);
  const [sort, setSort] = useState<SortState | null>({ columnId: 'symbol', direction: 'asc' });
  const shown = useMemo(() => sortRows(filterMarkets(rows, filter), columns, sort), [rows, filter, sort]);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          density="dense"
          aria-label="Search by symbol"
          placeholder="Search symbol"
          value={filter.search}
          onValueChange={(search) => setFilter((f) => ({ ...f, search }))}
          className="w-48"
        />
        <Select
          items={STATUS_ITEMS}
          value={filter.status}
          onValueChange={(v) => setFilter((f) => ({ ...f, status: (v ?? 'all') as MarketFilter['status'] }))}
        >
          <SelectTrigger size={32} aria-label="Filter by record status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_ITEMS).map(([v, label]) => (
              <SelectItem key={v} value={v}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={KIND_ITEMS}
          value={filter.kind}
          onValueChange={(v) => setFilter((f) => ({ ...f, kind: (v ?? 'all') as MarketFilter['kind'] }))}
        >
          <SelectTrigger size={32} aria-label="Filter by kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(KIND_ITEMS).map(([v, label]) => (
              <SelectItem key={v} value={v}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-fg-2" role="status">
          {shown.length} of {rows.length} markets
        </span>
      </div>
      <Table
        label="Markets"
        density="dense"
        columns={columns}
        rows={shown}
        getRowId={(r) => r.market.id}
        sort={sort}
        onSortChange={setSort}
        onRowActivate={(r) => router.push(`/trade-ops/markets/${encodeURIComponent(r.market.symbol)}`)}
        maxHeight={560}
      />
    </div>
  );
}
