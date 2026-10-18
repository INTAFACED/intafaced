'use client';

import { useMemo, useState } from 'react';
import { Badge, sortRows, Table, type SortState, type TableColumn } from '@intafaced/ui';
import type { AdminOrderRow } from '@/lib/trade-ops/reads';

/** Open orders resting on one market. A held order (outcome not known, funds reserved) says "Held", never plain open. */

const columns: readonly TableColumn<AdminOrderRow>[] = [
  { id: 'id', header: 'Order', value: (o) => o.id.slice(0, 8), pin: 'start', width: 90 },
  { id: 'side', header: 'Side', value: (o) => o.side, sortable: true, width: 60 },
  { id: 'type', header: 'Type', value: (o) => `${o.type} ${o.timeInForce}`, sortable: true },
  { id: 'price', header: 'Price', numeric: true, value: (o) => o.price, sortable: true },
  { id: 'amount', header: 'Amount', numeric: true, value: (o) => o.amount, sortable: true },
  { id: 'remaining', header: 'Remaining', numeric: true, value: (o) => o.remaining, sortable: true },
  {
    id: 'state',
    header: 'State',
    cell: (o) =>
      o.held ? (
        <Badge tone="warn" density="dense" icon="◐" title={o.recoveryReason ?? undefined}>
          Held
        </Badge>
      ) : (
        <Badge density="dense" icon="●">
          Open
        </Badge>
      ),
    sortValue: (o) => (o.held ? 'held' : 'open'),
    sortable: true,
    width: 80,
  },
  { id: 'source', header: 'Source', value: (o) => (o.seeded ? 'Seeded' : 'Customer'), sortable: true, width: 90 },
  { id: 'placed', header: 'Placed (UTC)', value: (o) => o.datetime.slice(0, 19).replace('T', ' '), sortable: true, width: 150 },
];

export function MarketOrders({ orders }: { orders: readonly AdminOrderRow[] }) {
  const [sort, setSort] = useState<SortState | null>({ columnId: 'placed', direction: 'desc' });
  const rows = useMemo(() => sortRows(orders, columns, sort), [orders, sort]);
  return (
    <Table
      label="Open orders on this market"
      density="dense"
      columns={columns}
      rows={rows}
      sort={sort}
      onSortChange={setSort}
      getRowId={(o) => o.id}
      maxHeight={320}
    />
  );
}
