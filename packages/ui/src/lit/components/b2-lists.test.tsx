import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToggleChips } from './index.js';
import { Sparkline } from './b2-charts.js';
import { rowStep, sortRows, Table, type Column } from './b2-table.js';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

interface Market {
  symbol: string;
  last: string;
}
const markets: Market[] = Array.from({ length: 200 }, (_, i) => ({ symbol: `C${i}/USDT`, last: `${i + 1}.5` }));
const columns: Column<Market>[] = [
  {
    key: 'name',
    label: 'Name',
    cell: (m) => (
      <a data-row-link="" href={`/coin/${m.symbol}`}>
        {m.symbol}
      </a>
    ),
    sortType: 'text',
  },
  {
    key: 'last',
    label: 'Price',
    cell: (m) => m.last,
    align: 'end',
    sortType: 'decimal',
    sortLabel: 'Sort by Price',
    cellMarks: () => ({ 'data-col': 'price' }),
  },
  { key: 'note', label: 'Note', cell: () => 'TEST' },
];

describe('table: sort, marks and virtual rows', () => {
  it('makes a sortable header a named button and says the sort in force with aria-sort', () => {
    const out = html(
      <Table
        caption="Markets"
        columns={columns}
        rows={markets.slice(0, 3)}
        rowKey={(m) => m.symbol}
        sort={{ columnId: 'last', direction: 'desc' }}
        onSort={() => {}}
      />,
    );
    expect(out).toContain(
      '<th scope="col" data-align="end" aria-sort="descending"><button type="button" class="lt-sort" aria-label="Sort by Price">Price',
    );
    expect(out).toContain('<th scope="col" data-align="start" aria-sort="none"><button type="button" class="lt-sort">Name');
    // A column with no sortType stays a plain header, with no aria-sort.
    expect(out).toContain('<th scope="col" data-align="start">Note</th>');
  });

  it('draws plain headers when the room passes no onSort', () => {
    const out = html(<Table caption="Markets" columns={columns} rows={markets.slice(0, 2)} rowKey={(m) => m.symbol} />);
    expect(out).not.toContain('lt-sort');
    expect(out).not.toContain('aria-sort');
  });

  it("keeps the row's and the cell's own marks, and the cell's own row link", () => {
    const out = html(
      <Table
        caption="Markets"
        columns={columns}
        rows={markets.slice(0, 2)}
        rowKey={(m) => m.symbol}
        rowMarks={(m) => ({ 'data-symbol': m.symbol, 'data-testid': 'mkt-row' })}
      />,
    );
    expect(out).toContain('data-symbol="C0/USDT" data-testid="mkt-row"');
    expect(out).toContain('<td data-col="price" data-label="Price" data-align="end">');
    expect(out).toContain('<a data-row-link="" href="/coin/C0/USDT">');
  });

  it("keeps the header row's and each header's own marks, and says when its rows are placeholders", () => {
    const marked = columns.map((c) => ({ ...c, headMarks: { 'data-col': c.key } }));
    const out = html(
      <Table
        caption="Markets"
        columns={marked}
        rows={markets.slice(0, 1)}
        rowKey={(m) => m.symbol}
        headMarks={{ 'data-testid': 'mkt-header' }}
        busy
      />,
    );
    expect(out).toContain('<table class="lt-table" data-mode="simple" aria-busy="true">');
    expect(out).toContain('<tr data-testid="mkt-header"><th data-col="name" scope="col" data-align="start">Name</th>');
    expect(html(<Table caption="Markets" columns={columns} rows={[]} rowKey={(m) => m.symbol} />)).not.toContain('aria-busy');
  });

  it('draws an honest empty line in place of no rows', () => {
    const out = html(<Table caption="Markets" columns={columns} rows={[]} rowKey={(m) => m.symbol} empty="No markets match" />);
    expect(out).toContain('<tr data-empty=""><td colSpan="3">No markets match</td></tr>');
  });

  it('draws only the first window of a long list, with a spacer holding the rest and the true row count', () => {
    const out = html(<Table caption="Markets" columns={columns} rows={markets} rowKey={(m) => m.symbol} virtual={{ estimate: 60 }} />);
    const drawn = out.match(/<tr data-row=""/g)?.length ?? 0;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(markets.length);
    expect(out).toContain('aria-rowcount="201"');
    expect(out).toContain('aria-rowindex="2"');
    expect(out).toMatch(
      new RegExp(`<tr aria-hidden="true" data-spacer=""><td colSpan="3" style="block-size:${(markets.length - drawn) * 60}px"></td></tr>`),
    );
  });

  it('draws every row of a short list, even when it may be virtual', () => {
    const out = html(
      <Table caption="Markets" columns={columns} rows={markets.slice(0, 50)} rowKey={(m) => m.symbol} virtual={{ estimate: 60 }} />,
    );
    expect(out.match(/<tr data-row=""/g)).toHaveLength(50);
    expect(out).not.toContain('data-spacer');
    expect(out).not.toContain('aria-rowcount');
    expect(out).toContain('data-index="49"');
  });

  it('moves between rows with the arrows, Home and End, never past either end', () => {
    expect(rowStep('ArrowDown', 0, 3)).toBe(1);
    expect(rowStep('ArrowUp', 1, 3)).toBe(0);
    expect(rowStep('ArrowUp', 0, 3)).toBeNull();
    expect(rowStep('ArrowDown', 2, 3)).toBeNull();
    expect(rowStep('Home', 2, 3)).toBe(0);
    expect(rowStep('End', 0, 3)).toBe(2);
    expect(rowStep('End', 2, 3)).toBeNull();
    expect(rowStep('Enter', 0, 3)).toBeNull();
  });

  it('a long virtual list also takes dense rows, a scrolling region and sorting headers', () => {
    const out = html(
      <Table
        caption="Markets"
        columns={columns}
        rows={markets}
        rowKey={(m) => m.symbol}
        virtual={{ estimate: 40 }}
        dense
        scroll
        sort={{ columnId: 'last', direction: 'asc' }}
        onSort={() => {}}
      />,
    );
    expect(
      out.startsWith('<div class="lt-table-scroll" tabindex="0" role="region" aria-label="Markets"><table class="lt-table lt-table-dense"'),
    ).toBe(true);
    expect(out).toContain('aria-rowcount="201"');
    expect(out).toContain('data-spacer=""');
    expect(out).toContain('aria-sort="ascending"><button type="button" class="lt-sort" aria-label="Sort by Price">');
    expect(out).not.toContain('role="grid"');
  });

  it('a pickable grid also takes dense rows, a scrolling region, sorting headers and its empty line', () => {
    const picked = html(
      <Table
        caption="Markets"
        columns={columns}
        rows={markets.slice(0, 3)}
        rowKey={(m) => m.symbol}
        selected="C1/USDT"
        onSelect={() => {}}
        dense
        scroll
        sort={null}
        onSort={() => {}}
      />,
    );
    expect(picked).toContain(
      '<div class="lt-table-scroll" tabindex="0" role="region" aria-label="Markets"><table class="lt-table lt-table-dense" data-mode="simple" role="grid">',
    );
    expect(picked).toContain('data-selected="true" aria-selected="true" tabindex="0"');
    expect(picked.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(picked).toContain('class="lt-sort" aria-label="Sort by Price"');
    expect(picked).not.toContain('data-index');
    const none = html(
      <Table caption="Markets" columns={columns} rows={[]} rowKey={(m) => m.symbol} onSelect={() => {}} empty="No markets" />,
    );
    expect(none).toContain('<tr data-empty=""><td colSpan="3">No markets</td></tr>');
  });

  it('refuses a pickable grid that is also virtual: its one Tab stop could be an undrawn row', () => {
    const both = (
      // @ts-expect-error onSelect and virtual never go together
      <Table caption="Markets" columns={columns} rows={markets} rowKey={(m) => m.symbol} onSelect={() => {}} virtual={{ estimate: 60 }} />
    );
    expect(both).toBeTruthy();
  });

  it('sorts decimal strings exactly, past what a float holds', () => {
    const rows = [{ v: '9007199254740993.1' }, { v: '9007199254740993.01' }, { v: '2' }];
    const sorted = sortRows(rows, [{ id: 'v', value: (r: { v: string }) => r.v, sortType: 'decimal' }], {
      columnId: 'v',
      direction: 'desc',
    });
    expect(sorted.map((r) => r.v)).toEqual(['9007199254740993.1', '9007199254740993.01', '2']);
  });
});

describe('sparkline', () => {
  it('draws a named line coloured by its direction, and nothing from fewer than two points', () => {
    const up = html(<Sparkline label="BTC/USDT" values={['1', '3', '2', '4']} />);
    expect(up).toContain('role="img"');
    expect(up).toContain('aria-label="BTC/USDT"');
    expect(up).toContain('data-tone="up"');
    expect(up).toContain('data-size="card"');
    expect(html(<Sparkline label="x" values={['5', '1']} />)).toContain('data-tone="down"');
    expect(html(<Sparkline label="x" values={['5']} />)).toBe('');
  });

  it("takes the room's direction when given, and a row's size", () => {
    const out = html(<Sparkline label="x" values={['1', '2']} tone="down" size="row" />);
    expect(out).toContain('data-tone="down"');
    expect(out).toContain('data-size="row"');
  });
});

describe('toggle chips', () => {
  const options = [
    { value: 'all', label: 'All' },
    { value: 'gainers', label: 'Gainers' },
  ] as const;
  it('is a named group of pressed buttons, the chip in force pressed', () => {
    const out = html(<ToggleChips label="Filter by change" options={options} value="gainers" onChange={() => {}} />);
    expect(out).toContain('role="group" aria-label="Filter by change"');
    expect(out).toContain('<button type="button" aria-pressed="false">All</button>');
    expect(out).toContain('<button type="button" aria-pressed="true">Gainers</button>');
  });

  it('presses none when the filter is off', () => {
    const out = html(<ToggleChips label="Filter by currency" options={options} value={null} onChange={() => {}} clearable />);
    expect(out).not.toContain('aria-pressed="true"');
  });
});
