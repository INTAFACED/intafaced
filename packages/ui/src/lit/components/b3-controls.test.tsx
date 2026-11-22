import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Table } from './b2-table.js';
import { Checkbox, DecimalField, Dialog, FreshnessChip, Select, TabSet } from './b3-controls.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const noop = () => undefined;

describe('b3 controls keep their roles and names', () => {
  it('a select is a closed combobox named by its label, showing the chosen option', () => {
    const out = html(
      <Select
        label="Pair"
        value="ETH/USDT"
        onChange={noop}
        options={[
          { value: 'BTC/USDT', label: 'BTC/USDT' },
          { value: 'ETH/USDT', label: 'ETH/USDT' },
        ]}
      />,
    );
    expect(out).toMatch(/role="combobox"[^>]*aria-labelledby="[^"]+-label"/);
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('>Pair</span>');
    expect(out).toContain('<span>ETH/USDT</span>');
    expect(out).not.toContain('role="listbox"');
  });

  it('a select whose value is not an option shows nothing chosen, never the first option', () => {
    const out = html(<Select label="Pair" value="" onChange={noop} options={[{ value: 'BTC/USDT', label: 'BTC/USDT' }]} />);
    expect(out).toContain('<span></span>');
  });

  it('a checkbox is a native box named by its words', () => {
    const out = html(<Checkbox label="House desk (TEST)" checked onChange={noop} />);
    expect(out).toMatch(/<label class="lt-check"><input type="checkbox" checked=""\/><span>House desk \(TEST\)<\/span><\/label>/);
  });

  it('a tab set draws every tab and only the open panel, labelled by its tab', () => {
    const out = html(
      <TabSet
        label="Sections"
        value="b"
        onChange={noop}
        tabs={[
          { value: 'a', label: 'Chain', panel: <p>panel a</p> },
          { value: 'b', label: 'Orders', panel: <p>panel b</p> },
        ]}
      />,
    );
    expect(out).toContain('role="tablist" aria-label="Sections"');
    expect(out.match(/role="tab"/g)).toHaveLength(2);
    expect(out).toMatch(/aria-selected="true"[^>]*>Orders</);
    expect(out).toContain('panel b');
    expect(out).not.toContain('panel a');
    expect(out).toMatch(/role="tabpanel" id="[^"]+-panel-b" aria-labelledby="[^"]+-tab-b"/);
  });

  it('a dialog draws its content only while open, as an alert dialog when asked', () => {
    const closed = html(
      <Dialog open={false} alert title="Place this order?" onClose={noop}>
        <p>body</p>
      </Dialog>,
    );
    expect(closed).toContain('role="alertdialog"');
    expect(closed).not.toContain('Place this order?');
    expect(closed).not.toContain('body');
    const open = html(
      <Dialog open alert title="Place this order?" description="Buy 1" onClose={noop}>
        <p>body</p>
      </Dialog>,
    );
    expect(open).toContain('Place this order?');
    expect(open).toContain('Buy 1');
    expect(open).toMatch(/aria-labelledby="[^"]+"/);
  });

  it('a decimal field names itself by its label alone and keeps the unit beside it', () => {
    const out = html(<DecimalField label="Limit price" unit="USDT" value="500" onValueChange={noop} precision={2} hint="Step 0.5" />);
    expect(out).toMatch(/<label for="([^"]+)">Limit price<\/label>/);
    expect(out).toContain('inputMode="decimal"');
    expect(out).toContain('value="500"');
    expect(out).toContain('<span class="lt-field-unit">USDT</span>');
    expect(out).toContain('Step 0.5');
  });

  it('a freshness chip is a status that starts with its word', () => {
    expect(html(<FreshnessChip asOf={1_800_000_000_000} now={1_800_000_001_000} staleAfterMs={10_000} />)).toMatch(
      /role="status"[^>]*data-freshness="live"/,
    );
    expect(html(<FreshnessChip asOf={1_800_000_000_000} now={1_800_000_001_000} staleAfterMs={10_000} />)).toMatch(/<span>Live<\/span>/);
    expect(html(<FreshnessChip asOf={1_800_000_000_000} now={1_800_000_060_000} staleAfterMs={10_000} />)).toMatch(/<span>Stale<\/span>/);
    expect(html(<FreshnessChip asOf={null} now={1_800_000_060_000} staleAfterMs={10_000} />)).toMatch(/<span>Unknown<\/span>/);
    expect(html(<FreshnessChip asOf={1_800_000_000_000} now={1_800_000_001_000} refused staleAfterMs={10_000} />)).toMatch(
      /<span>Refused<\/span>/,
    );
  });
});

describe('the table sorts, picks a row in place and says when it is empty', () => {
  const columns = [
    { key: 'name', label: 'Name', cell: (r: { name: string }) => r.name, sortType: 'text' as const },
    { key: 'size', label: 'Size', cell: () => '1' },
  ];
  it('a sortable header is a button and carries aria-sort; the rest stay plain', () => {
    const out = html(
      <Table
        caption="Rows"
        columns={columns}
        rows={[{ name: 'a' }]}
        rowKey={(r) => r.name}
        sort={{ columnId: 'name', direction: 'asc' }}
        onSort={noop}
      />,
    );
    expect(out).toMatch(/<th scope="col" data-align="start" aria-sort="ascending"><button type="button" class="lt-sort">Name/);
    expect(out).toContain('<th scope="col" data-align="start">Size</th>');
  });
  it('a row picked in place is a button in its first cell, pressed when selected', () => {
    const out = html(
      <Table caption="Rows" columns={columns} rows={[{ name: 'a' }]} rowKey={(r) => r.name} onRowSelect={noop} selected="a" />,
    );
    expect(out).toContain('<button type="button" class="lt-row-link" aria-pressed="true">');
  });
  it('no rows draws the empty words across the table', () => {
    const out = html(<Table caption="Rows" columns={columns} rows={[]} rowKey={(r) => r.name} empty="Nothing here" />);
    expect(out).toContain('<tr data-empty=""><td colSpan="2">Nothing here</td></tr>');
  });
});
