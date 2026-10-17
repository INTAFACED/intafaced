'use client';

import { useState } from 'react';
import { Badge, Table, sortRows, type SortState, type TableColumn } from '@intafaced/ui';
import { feeCellFor, feeCellText, type EffectiveFees } from '@/lib/trade-ops/fees-model';
import type { Outcome } from '@/lib/trade-ops/outcome';
import type { MarketRow } from '@/lib/trade-ops/reads';

/** Per-market limits the service lets the desk read: tick, lot, min and max quantity, min notional, the fee customers are charged. The listing-row maker/taker bps are metadata and are
 * not charged. A blank or unread schedule shows its refusal or a dash, never a guessed number. */
export function RiskLimitsTable({ markets, fees }: { markets: readonly MarketRow[]; fees: Outcome<EffectiveFees> }) {
  const [sort, setSort] = useState<SortState | null>(null);
  const columns: TableColumn<MarketRow>[] = [
    { id: 'symbol', header: 'Market', value: (m) => m.symbol, sortable: true, pin: 'start', width: 130 },
    { id: 'kind', header: 'Kind', cell: (m) => <Badge density="dense">{m.kind}</Badge>, value: (m) => m.kind, width: 80 },
    { id: 'tick', header: 'Tick', numeric: true, sortable: true, sortType: 'decimal', value: (m) => m.tickSize },
    { id: 'lot', header: 'Lot', numeric: true, sortable: true, sortType: 'decimal', value: (m) => m.lotSize },
    { id: 'minQty', header: 'Min qty', numeric: true, sortable: true, sortType: 'decimal', value: (m) => m.minQty },
    { id: 'maxQty', header: 'Max qty', numeric: true, sortable: true, sortType: 'decimal', value: (m) => m.maxQty },
    { id: 'minNotional', header: 'Min notional', numeric: true, sortable: true, sortType: 'decimal', value: (m) => m.minNotional },
    {
      id: 'charged',
      header: 'Fee charged (maker / taker)',
      numeric: true,
      cell: (m) => feeCellText(feeCellFor(fees, m.symbol)),
      value: (m) => feeCellText(feeCellFor(fees, m.symbol)),
      width: 290,
    },
    {
      id: 'listing',
      header: 'Listing bps, not charged',
      numeric: true,
      cell: (m) => <span className="text-fg-2">{`${m.makerBps} / ${m.takerBps}`}</span>,
      value: (m) => `${m.makerBps} / ${m.takerBps}`,
      width: 190,
    },
  ];
  const rows = sortRows(markets, columns, sort);
  return (
    <Table<MarketRow>
      label="Readable risk limits per market"
      density="dense"
      columns={columns}
      rows={rows}
      getRowId={(m) => m.id}
      sort={sort}
      onSortChange={setSort}
    />
  );
}
