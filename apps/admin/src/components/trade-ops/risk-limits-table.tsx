'use client';

import { useState } from 'react';
import { Badge, Table, sortRows, type SortState, type TableColumn } from '@intafaced/ui';
import type { MarketRow } from '@/lib/trade-ops/reads';

/** Per-market limits the service lets the desk read: tick, lot, min and max quantity, min notional, maker/taker fee. Unknown draws a dash. */
export function RiskLimitsTable({ markets }: { markets: readonly MarketRow[] }) {
  const [sort, setSort] = useState<SortState | null>(null);
  const columns: TableColumn<MarketRow>[] = [
    { id: 'symbol', header: 'Market', value: (m) => m.symbol, sortable: true, pin: 'start', width: 130 },
    { id: 'kind', header: 'Kind', cell: (m) => <Badge density="dense">{m.kind}</Badge>, value: (m) => m.kind, width: 80 },
    { id: 'tick', header: 'Tick', numeric: true, sortable: true, sortType: 'decimal', value: (m) => m.tickSize },
    { id: 'lot', header: 'Lot', numeric: true, sortable: true, sortType: 'decimal', value: (m) => m.lotSize },
    { id: 'minQty', header: 'Min qty', numeric: true, sortable: true, sortType: 'decimal', value: (m) => m.minQty },
    { id: 'maxQty', header: 'Max qty', numeric: true, sortable: true, sortType: 'decimal', value: (m) => m.maxQty },
    { id: 'minNotional', header: 'Min notional', numeric: true, sortable: true, sortType: 'decimal', value: (m) => m.minNotional },
    { id: 'maker', header: 'Maker bps', numeric: true, sortable: true, sortType: 'decimal', value: (m) => String(m.makerBps) },
    { id: 'taker', header: 'Taker bps', numeric: true, sortable: true, sortType: 'decimal', value: (m) => String(m.takerBps) },
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
