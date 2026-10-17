/**
 * Gallery section for Table. Every figure is TEST DATA for layout, never a real market or balance.
 */
import * as React from 'react';
import { Pct } from '../../numbers.js';
import { StatusTag } from '../../status-tag.js';
import { Table, type TableColumn } from '../../table.js';
import { sortRows, type SortState } from '../../table-logic.js';

interface Market {
  id: string;
  pair: string;
  price: string | null;
  change: string | null;
  volume: string | null;
}

// TEST DATA
const markets: Market[] = [
  { id: 'm1', pair: 'AAA/USDT', price: '83281.8', change: '+1.24%', volume: '1204389.12' },
  { id: 'm2', pair: 'BBB/USDT', price: '1.000000000000000001', change: '−0.28%', volume: '98.5' },
  { id: 'm3', pair: 'CCC/USDT', price: '0.1', change: '+0.00%', volume: '12.000000000000000001' },
  { id: 'm4', pair: 'DDD/USDT', price: '0.10', change: '+4.02%', volume: null },
  { id: 'm5', pair: 'EEE/USDT', price: null, change: null, volume: null },
  { id: 'm6', pair: 'FFF/USDT', price: '1.000000000000000002', change: '−1.90%', volume: '7320.4' },
];

// Wide enough for every digit of the 18-decimal TEST prices; a phone scrolls sideways instead of cutting digits.
const MARKETS_MIN_WIDTH = 760;
const marketColumns: TableColumn<Market>[] = [
  { id: 'pair', header: 'Market', value: (r) => r.pair, sortable: true, pin: 'start', width: 180 },
  { id: 'price', header: 'Last price', value: (r) => r.price, numeric: true, sortable: true, width: 230 },
  {
    id: 'change',
    header: '24h change',
    value: (r) => r.change,
    numeric: true,
    cell: (r) => (r.change === null ? null : <Pct value={r.change} />),
  },
  { id: 'volume', header: 'Volume', value: (r) => r.volume, numeric: true, sortable: true, width: 200 },
];

interface Order {
  id: string;
  side: 'Buy' | 'Sell';
  pair: string;
  size: string;
  status: 'working' | 'pending' | 'failed';
}

// TEST DATA
const orders: Order[] = [
  { id: 'o1', side: 'Buy', pair: 'AAA/USDT', size: '0.0042', status: 'working' },
  { id: 'o2', side: 'Sell', pair: 'BBB/USDT', size: '120.5', status: 'pending' },
  { id: 'o3', side: 'Buy', pair: 'CCC/USDT', size: '0.123456789012345678', status: 'failed' },
  { id: 'o4', side: 'Sell', pair: 'AAA/USDT', size: '2', status: 'working' },
];

const orderColumns: TableColumn<Order>[] = [
  { id: 'side', header: 'Side', value: (r) => r.side, width: 72 },
  { id: 'pair', header: 'Market', value: (r) => r.pair, sortable: true },
  { id: 'size', header: 'Size', value: (r) => r.size, numeric: true, sortable: true },
  { id: 'status', header: 'Status', cell: (r) => <StatusTag status={r.status} />, width: 120 },
];

// The main orders table gets real widths and a minimum width, so the 18-decimal size is never cut and a phone scrolls sideways.
const ORDERS_MIN_WIDTH = 560;
const wideOrderColumns = orderColumns.map((c) => (c.id === 'pair' ? { ...c, width: 130 } : c.id === 'size' ? { ...c, width: 190 } : c));

interface Big {
  id: string;
  n: string;
  amount: string;
}
// TEST DATA: 10,000 generated rows.
const big: Big[] = Array.from({ length: 10000 }, (_, i) => ({
  id: `b${i}`,
  n: `Row ${i + 1}`,
  amount: `${i}.${String(i % 1000).padStart(3, '0')}`,
}));
const bigColumns: TableColumn<Big>[] = [
  { id: 'n', header: 'Row', value: (r) => r.n, width: 200 },
  { id: 'amount', header: 'Amount', value: (r) => r.amount, numeric: true },
];

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 mt-6 text-sm text-fg-2">{children}</p>;
}

export function TableSection() {
  const [sort, setSort] = React.useState<SortState | null>({ columnId: 'price', direction: 'desc' });
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set(['o2']));
  const [single, setSingle] = React.useState<ReadonlySet<string>>(new Set(['m2']));
  const [opened, setOpened] = React.useState('none');
  const sorted = React.useMemo(() => sortRows(markets, marketColumns, sort), [sort]);

  return (
    <section id="kit-table" className="border-t border-line py-8">
      <h2 className="mb-1 text-lg font-semibold">Table · TEST DATA</h2>
      <p className="text-sm text-fg-2">
        Click a header to sort. The price column holds values one unit apart in the 18th decimal place: they stay in the right order.
        Unknown values show a dash and always sort last.
      </p>

      <Caption>
        Comfortable, sortable, pinned first column (stays put when the table scrolls sideways on a narrow screen), single selection (click
        or Space on a row)
      </Caption>
      <Table<Market>
        label="Markets, comfortable"
        minWidth={MARKETS_MIN_WIDTH}
        columns={marketColumns}
        rows={sorted}
        getRowId={(r) => r.id}
        sort={sort}
        onSortChange={setSort}
        selection="single"
        selectedIds={single}
        onSelectionChange={setSingle}
      />

      <Caption>Dense (pro desk), multiple selection, Enter opens a row. Last opened: {opened}</Caption>
      <Table<Order>
        label="Open orders, dense"
        density="dense"
        minWidth={ORDERS_MIN_WIDTH}
        columns={wideOrderColumns}
        rows={orders}
        getRowId={(r) => r.id}
        selection="multiple"
        selectedIds={selected}
        onSelectionChange={setSelected}
        onRowActivate={(r) => setOpened(r.id)}
      />

      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-3">
        <div>
          <Caption>Loading</Caption>
          <Table<Order>
            label="Open orders (loading)"
            density="dense"
            columns={orderColumns}
            rows={[]}
            getRowId={(r) => r.id}
            status="loading"
            loadingRows={4}
          />
        </div>
        <div>
          <Caption>Empty</Caption>
          <Table<Order> label="Open orders (empty)" density="dense" columns={orderColumns} rows={[]} getRowId={(r) => r.id} />
        </div>
        <div>
          <Caption>Error (with retry)</Caption>
          <Table<Order>
            label="orders"
            density="dense"
            columns={orderColumns}
            rows={[]}
            getRowId={(r) => r.id}
            status="error"
            onRetry={() => undefined}
          />
        </div>
      </div>

      <Caption>Virtualised: 10,000 rows, only the visible ones exist in the page (dense, 320 px tall)</Caption>
      <Table<Big>
        label="Ten thousand rows"
        density="dense"
        columns={bigColumns}
        rows={big}
        getRowId={(r) => r.id}
        virtualize
        maxHeight={320}
        onRowActivate={() => undefined}
      />
    </section>
  );
}
