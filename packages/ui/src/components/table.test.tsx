import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Table, type TableColumn, type TableProps } from './table.js';

// Everything here is TEST DATA written for these tests. None of it is a real market or balance.
interface Row {
  id: string;
  asset: string;
  amount: string | null;
  note?: string;
}

const columns: TableColumn<Row>[] = [
  { id: 'asset', header: 'Asset', value: (r) => r.asset, sortable: true, pin: 'start' },
  { id: 'amount', header: 'Amount', value: (r) => r.amount, numeric: true, sortable: true },
  { id: 'note', header: 'Note', value: (r) => r.note ?? null },
];

const rows: Row[] = [
  { id: 'r1', asset: 'AAA', amount: '0.1' },
  { id: 'r2', asset: 'BBB', amount: '0.123456789012345678' },
  { id: 'r3', asset: 'CCC', amount: null },
];

const html = (props: Partial<TableProps<Row>> = {}) =>
  renderToStaticMarkup(<Table<Row> label="Test rows" columns={columns} rows={rows} getRowId={(r) => r.id} {...props} />);

describe('Table markup', () => {
  it('is a real table with a caption, scoped column headers and one row per record', () => {
    const out = html();
    expect(out).toContain('<table');
    expect(out).toContain('<caption class="sr-only">Test rows</caption>');
    expect(out.match(/<th /g)).toHaveLength(3);
    expect(out.match(/scope="col"/g)).toHaveLength(3);
    expect(out.match(/data-slot="table-row"/g)).toHaveLength(3);
    expect(out).not.toContain('role="grid"');
  });

  it('right-aligns numeric columns with tabular figures and keeps every digit', () => {
    const out = html();
    expect(out).toContain('data-align="end"');
    expect(out).toContain('tabular-nums');
    expect(out).toContain('0.123456789012345678');
  });

  it('draws an unknown value as a dash, never a zero', () => {
    const out = html();
    expect(out).toContain('—');
    const row3 = out.slice(out.indexOf('CCC'));
    expect(row3).not.toMatch(/>0</);
  });

  it('applies density classes', () => {
    expect(html({ density: 'dense' })).toContain('h-(--if-table-row-h-dense)');
    expect(html({ density: 'dense' })).toContain('data-density="dense"');
    expect(html()).toContain('h-(--if-table-row-h)');
    expect(html()).toContain('data-density="comfortable"');
  });

  it('keeps the header sticky by default and can switch it off', () => {
    expect(html()).toContain('sticky top-0');
    expect(html({ stickyHeader: false })).not.toContain('sticky top-0');
  });

  it('pins the first column only when asked', () => {
    expect(html()).toContain('sticky left-0');
    expect(html({ columns: columns.map((c) => ({ ...c, pin: undefined })) })).not.toContain('sticky left-0');
  });
});

describe('Table sorting', () => {
  it('exposes aria-sort and a button only on sortable headers when sorting is wired', () => {
    const out = html({ sort: { columnId: 'amount', direction: 'desc' }, onSortChange: () => undefined });
    expect(out).toContain('aria-sort="descending"');
    expect(out).toContain('aria-sort="none"');
    expect(out.match(/data-slot="table-sort"/g)).toHaveLength(2);
    expect(out.match(/<button/g)).toHaveLength(2);
  });

  it('shows the sort state but no buttons without onSortChange (server-sorted tables)', () => {
    const out = html({ sort: { columnId: 'asset', direction: 'asc' } });
    expect(out).toContain('aria-sort="ascending"');
    expect(out).not.toContain('table-sort');
  });
});

describe('Table states', () => {
  it('loading keeps the header, draws skeleton rows of the final height and announces', () => {
    const out = html({ status: 'loading', loadingRows: 4 });
    expect(out).toContain('aria-busy="true"');
    expect(out.match(/data-slot="table-skeleton-row"/g)).toHaveLength(4);
    expect(out).toContain('role="status"');
    expect(out).toContain('Loading');
    expect(out).toContain('Asset');
    expect(out).not.toContain('data-slot="table-row"');
  });

  it('empty shows the empty row inside the table, custom or default', () => {
    const out = html({ rows: [] });
    expect(out).toContain('data-slot="table-empty-row"');
    expect(out).toContain('Nothing to show');
    expect(html({ rows: [], emptyState: <p>No orders yet</p> })).toContain('No orders yet');
  });

  it('error shows an alert row with retry, or a custom node', () => {
    const out = html({ status: 'error', onRetry: () => undefined });
    expect(out).toContain('data-slot="table-error-row"');
    expect(out).toContain('role="alert"');
    expect(out).toContain('Try again');
    expect(out).not.toContain('data-slot="table-row"');
    expect(html({ status: 'error', errorState: <p>Refused: region</p> })).toContain('Refused: region');
  });

  it('refreshing keeps the rows and marks the table busy', () => {
    const out = html({ refreshing: true });
    expect(out).toContain('aria-busy="true"');
    expect(out.match(/data-slot="table-row"/g)).toHaveLength(3);
  });
});

describe('Table selection and interaction', () => {
  it('multiple selection adds a select-all box, per-row boxes and the grid role', () => {
    const out = html({ selection: 'multiple', selectedIds: new Set(['r1']), onSelectionChange: () => undefined });
    expect(out).toContain('role="grid"');
    expect(out).toContain('aria-multiselectable="true"');
    expect(out).toContain('aria-label="Select all rows"');
    expect(out.match(/aria-label="Select row"/g)).toHaveLength(3);
    expect(out).toContain('aria-selected="true"');
    expect(out.match(/aria-selected="false"/g)).toHaveLength(2);
    expect(out).toContain('data-selected="true"');
    expect(out).toContain('indeterminate');
  });

  it('only the first row is in the tab order when rows are interactive', () => {
    const out = html({ onRowActivate: () => undefined });
    expect(out).toContain('role="grid"');
    expect(out.match(/tabindex="0"/g)).toHaveLength(1);
    expect(out.match(/tabindex="-1"/g)).toHaveLength(2);
  });

  it('plain tables have no focusable rows', () => {
    expect(html()).not.toContain('tabindex');
  });

  it('labels can be overridden', () => {
    const out = html({ status: 'loading', labels: { loading: 'Laden' } });
    expect(out).toContain('Laden');
  });
});

describe('Table virtualisation', () => {
  const many: Row[] = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}`, asset: `A${i}`, amount: `${i}.5` }));

  it('renders a window of rows with spacers, not all 5000', () => {
    const out = html({ rows: many, virtualize: true, maxHeight: 300, density: 'comfortable' });
    const rendered = out.match(/data-slot="table-row"/g)!.length;
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(40);
    expect(out).toContain('data-slot="table-spacer"');
    expect(out).toContain('data-row-index="0"');
    expect(out).not.toContain('data-row-index="4999"');
  });

  it('tells assistive tech the true size', () => {
    const out = html({ rows: many, virtualize: true, maxHeight: 300 });
    expect(out).toContain('aria-rowcount="5001"');
    expect(out).toContain('aria-rowindex="2"');
  });

  it('is a labelled, scrollable region', () => {
    const out = html({ rows: many, virtualize: true, maxHeight: 300 });
    expect(out).toContain('role="region"');
    expect(out).toContain('aria-label="Test rows"');
    expect(out).toContain('max-height:300px');
  });

  it('dense rows fit more rows in the same height', () => {
    const count = (density: 'dense' | 'comfortable') =>
      html({ rows: many, virtualize: true, maxHeight: 300, density }).match(/data-slot="table-row"/g)!.length;
    expect(count('dense')).toBeGreaterThan(count('comfortable'));
  });
});
