'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Stat,
  Table,
  sortRows,
  type SortState,
  type TableColumn,
} from '@intafaced/ui';
import type { AdminOrderRow } from '@/lib/trade-ops/reads';
import {
  cleanOrderId,
  explainHold,
  filterOrders,
  marketsOf,
  NO_FILTERS,
  ordersToCsv,
  PAGE_SIZES,
  shortId,
  statusWord,
  STATUS_FILTERS,
  summarize,
  truncationNotice,
  type OrderFilters,
} from '@/lib/trade-ops/orders-model';

/**
 * The open-orders blotter: summary strip, filters, page size, exact-decimal sorting, row selection with
 * "Save selected as CSV" (client side, only the rows ticked), the honest truncation notice and a panel for held orders.
 * A row opens the order page. Everything shown is a row the service returned; nothing is computed into a total.
 */

function Sel({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  const items = Object.fromEntries(options.map((o) => [o.value, o.label]));
  return (
    <Field label={label} density="dense">
      <Select items={items} value={value} onValueChange={(v) => onChange(v ?? options[0]?.value ?? '')}>
        <SelectTrigger size={32} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function CopyId({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="flex items-center gap-1">
      <code className="if-mono text-xs">{shortId(id)}</code>
      <Button
        size={28}
        variant="ghost"
        shape="rounded"
        aria-label={`Copy order id ${id}`}
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard?.writeText(id).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {done ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

export function OrdersBoard({ rows, limit }: { rows: readonly AdminOrderRow[]; limit: number }) {
  const router = useRouter();
  const [filters, setFilters] = useState<OrderFilters>(NO_FILTERS);
  const [sort, setSort] = useState<SortState | null>({ columnId: 'created', direction: 'desc' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lookup, setLookup] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);
  const set = (p: Partial<OrderFilters>) => setFilters((f) => ({ ...f, ...p }));

  const columns: TableColumn<AdminOrderRow>[] = [
    { id: 'id', header: 'Order id', width: 150, cell: (o) => <CopyId id={o.id} />, value: (o) => o.id, sortable: true },
    { id: 'account', header: 'Account', width: 90, value: (o) => shortId(o.userId), sortValue: (o) => o.userId, sortable: true },
    { id: 'market', header: 'Market', value: (o) => o.symbol, sortable: true },
    {
      id: 'side',
      header: 'Side',
      width: 70,
      sortable: true,
      value: (o) => o.side,
      cell: (o) => (
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true">{o.side === 'buy' ? '▲' : '▼'}</span>
          {o.side === 'buy' ? 'Buy' : 'Sell'}
        </span>
      ),
    },
    { id: 'type', header: 'Type', width: 70, value: (o) => o.type, sortable: true },
    { id: 'tif', header: 'TIF', width: 56, value: (o) => o.timeInForce, sortable: true },
    { id: 'price', header: 'Price', numeric: true, sortable: true, value: (o) => o.price },
    { id: 'amount', header: 'Amount', numeric: true, sortable: true, value: (o) => o.amount },
    { id: 'filled', header: 'Filled', numeric: true, sortable: true, value: (o) => o.filled },
    { id: 'remaining', header: 'Remaining', numeric: true, sortable: true, value: (o) => o.remaining },
    {
      id: 'status',
      header: 'Status',
      width: 150,
      sortable: true,
      value: (o) => statusWord(o).label,
      cell: (o) => {
        const s = statusWord(o);
        return (
          <Badge tone={s.tone} variant={s.key === 'held' ? 'outline' : 'soft'} density="dense">
            {s.key === 'held' ? '◆ ' : ''}
            {s.label}
          </Badge>
        );
      },
    },
    {
      id: 'seeded',
      header: 'Origin',
      width: 90,
      sortable: true,
      value: (o) => (o.seeded ? 'House seed' : 'Customer'),
      cell: (o) => (
        <Badge tone={o.seeded ? 'neutral' : 'lime'} variant="outline" density="dense">
          {o.seeded ? 'House seed' : 'Customer'}
        </Badge>
      ),
    },
    {
      id: 'created',
      header: 'Created (UTC)',
      width: 150,
      sortable: true,
      value: (o) => o.datetime.slice(0, 19).replace('T', ' '),
      sortValue: (o) => o.datetime,
    },
  ];

  const filtered = useMemo(() => filterOrders(rows, filters), [rows, filters]);
  const sorted = useMemo(() => sortRows(filtered, columns, sort), [filtered, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const summary = summarize(rows);
  const notice = truncationNotice(rows.length, limit);
  const heldRows = rows.filter((o) => o.held);
  const markets = marketsOf(rows);
  const picked = rows.filter((o) => selected.has(o.id));

  function saveCsv() {
    const url = URL.createObjectURL(new Blob([ordersToCsv(picked)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `open-orders-selected-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function goLookup() {
    const id = cleanOrderId(lookup);
    if (!id) return setLookupError('Enter an order id: letters, digits and - _ . : only.');
    setLookupError(null);
    router.push(`/trade-ops/orders/${encodeURIComponent(id)}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Rows returned" value={String(summary.shown)} hint={`of up to ${limit} requested`} density="dense" />
        <Stat label="Open (not held)" value={String(summary.open)} density="dense" />
        <Stat label="House seed" value={String(summary.seeded)} hint="seeded liquidity" density="dense" />
        <Stat label="Held for recovery" value={String(summary.held)} hint="funds reserved, outcome unknown" density="dense" />
      </div>

      {notice ? (
        <p role="status" className="border border-line px-3 py-2 text-sm text-warn">
          <span aria-hidden="true">◆ </span>
          {notice}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Find an order by id" hint={lookupError ?? undefined} error={lookupError ?? undefined} density="dense">
          <Input value={lookup} onValueChange={setLookup} density="dense" onKeyDown={(e) => e.key === 'Enter' && goLookup()} />
        </Field>
        <Button size={32} variant="secondary" shape="rounded" onClick={goLookup}>
          Open order
        </Button>
        <Sel
          label="Page size"
          value={String(limit)}
          onChange={(v) => router.push(`/trade-ops/orders?limit=${v}`)}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} rows` }))}
        />
        <Button size={32} variant="ghost" shape="rounded" onClick={() => router.refresh()}>
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Sel
          label="Market"
          value={filters.market}
          onChange={(v) => set({ market: v })}
          options={[{ value: 'all', label: 'All markets' }, ...markets.map((m) => ({ value: m, label: m }))]}
        />
        <Sel
          label="Side"
          value={filters.side}
          onChange={(v) => set({ side: v })}
          options={[
            { value: 'all', label: 'Buy and sell' },
            { value: 'buy', label: 'Buy' },
            { value: 'sell', label: 'Sell' },
          ]}
        />
        <Sel
          label="Origin"
          value={filters.origin}
          onChange={(v) => set({ origin: v })}
          options={[
            { value: 'all', label: 'House seed and customer' },
            { value: 'seeded', label: 'House seed only' },
            { value: 'customer', label: 'Customer only' },
          ]}
        />
        <Sel label="Status" value={filters.status} onChange={(v) => set({ status: v })} options={STATUS_FILTERS} />
        <Field label="User id contains" density="dense">
          <Input value={filters.userId} onValueChange={(v) => set({ userId: v })} density="dense" />
        </Field>
        <Field label="Order id contains" density="dense">
          <Input value={filters.idSearch} onValueChange={(v) => set({ idSearch: v })} density="dense" />
        </Field>
        <Button size={32} variant="ghost" shape="rounded" onClick={() => setFilters(NO_FILTERS)}>
          Clear filters
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm text-fg-2">
        <span>
          Showing {sorted.length} of {rows.length} returned rows. {picked.length} selected.
        </span>
        <Button size={28} variant="secondary" shape="rounded" disabled={picked.length === 0} onClick={saveCsv}>
          Save selected as CSV
        </Button>
        {picked.length === 0 ? (
          <span className="text-xs text-fg-3">Tick rows to enable. Only the rows ticked are saved, from this screen.</span>
        ) : null}
      </div>

      <Table
        label="Open orders across accounts"
        columns={columns}
        rows={sorted}
        getRowId={(o) => o.id}
        density="dense"
        sort={sort}
        onSortChange={setSort}
        selection="multiple"
        selectedIds={selected}
        onSelectionChange={setSelected}
        onRowActivate={(o) => router.push(`/trade-ops/orders/${encodeURIComponent(o.id)}`)}
        maxHeight={520}
        emptyState={
          <EmptyState
            variant="empty"
            size="inline"
            title={rows.length === 0 ? 'The service returned no open orders' : 'No returned order matches these filters'}
          />
        }
      />

      {heldRows.length > 0 ? (
        <section aria-label="Held orders" className="border border-line">
          <h2 className="border-b border-line px-3 py-2 text-sm font-medium">Held for recovery ({heldRows.length})</h2>
          <ul className="divide-y divide-line">
            {heldRows.map((o) => {
              const e = explainHold(o.recoveryReason);
              return (
                <li key={o.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
                  <a className="underline" href={`/trade-ops/orders/${encodeURIComponent(o.id)}`}>
                    <code className="if-mono text-xs">{o.id}</code>
                  </a>
                  <span className="text-fg-2">
                    {o.symbol} · {o.side} · {e.heading}. {e.stage}
                  </span>
                  <span className="text-xs text-fg-3">
                    Reason: {o.recoveryReason ?? '—'} · Reconciliation key: <code className="if-mono">{o.reconciliationKey ?? '—'}</code>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
