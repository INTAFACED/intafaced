// GridTable and FreshnessTag: the kit's table named as a grid, and the freshness word with its time.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FreshnessTag } from './freshness-tag.js';
import { GridTable, type GridColumn } from './grid-table.js';

type Row = { id: string; price: string };
const columns: GridColumn<Row>[] = [
  { key: 'id', label: 'Name', cell: (r) => r.id, sortType: 'text', sortLabel: 'Sort by Name' },
  { key: 'price', label: 'Price', cell: (r) => r.price, align: 'end' },
  { key: 'action', label: 'Action', cell: () => <a href="/x">Go</a>, quietLabel: true },
];
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('GridTable', () => {
  it('is a named grid on the kit table, its rows carrying their marks and labels', () => {
    const out = html(
      <GridTable
        caption="Markets"
        columns={columns}
        rows={[{ id: 'BTC', price: '1' }]}
        rowKey={(r) => r.id}
        rowMarks={(r) => ({ 'data-symbol': r.id })}
        sort={{ columnId: 'id', direction: 'asc' }}
        onSort={() => undefined}
      />,
    );
    expect(out).toContain('<table class="lt-table" role="grid" aria-label="Markets" data-mode="simple">');
    expect(out).toContain('<tr data-symbol="BTC" data-row="">');
    expect(out).toContain('aria-sort="ascending"');
    expect(out).toContain('aria-label="Sort by Name"');
    expect(out).toContain('<span class="lt-sr">Action</span>');
    expect(out).toContain('data-label="Price" data-align="end">1</td>');
  });

  it('loading draws placeholder rows and says busy; no rows draws the empty line', () => {
    const loading = html(<GridTable caption="M" columns={columns} rows={[]} rowKey={(r) => r.id} loadingRows={4} empty="None" />);
    expect(loading).toContain('aria-busy="true"');
    expect(loading.match(/data-ghost=""/g)).toHaveLength(4);
    expect(loading).not.toContain('None');
    const empty = html(<GridTable caption="M" columns={columns} rows={[]} rowKey={(r) => r.id} empty="None" />);
    expect(empty).toContain('<tr data-empty=""><td colSpan="3">None</td></tr>');
  });
});

describe('FreshnessTag', () => {
  const words = { live: 'Live', stale: 'Stale', unknown: 'Unknown', refused: 'Refused' };
  it('names an unknown or refused feed with its reason, and no time', () => {
    const out = html(<FreshnessTag asOf={null} staleAfterMs={30000} words={words} asOfLabel="as of" reason="Prices have not arrived" />);
    expect(out).toContain('data-freshness="unknown"');
    expect(out).toContain('<span class="lt-sr">Prices have not arrived</span>');
    expect(out).not.toContain('<time');
    expect(html(<FreshnessTag asOf={null} staleAfterMs={30000} refused words={words} asOfLabel="as of" />)).toContain('Refused');
  });
  it('a stale feed keeps its time', () => {
    const out = html(<FreshnessTag asOf="2020-01-01T10:00:00Z" staleAfterMs={30000} words={words} asOfLabel="as of" timeZone="UTC" />);
    expect(out).toContain('data-freshness="stale"');
    expect(out).toContain('as of <time dateTime="2020-01-01T10:00:00.000Z"');
  });
});

describe('SearchField and CardRow', () => {
  it('the search box is named for assistive tech, its mark decorative', async () => {
    const { SearchField } = await import('./search-field.js');
    const out = html(<SearchField id="s" label="Search markets" icon="⌕" placeholder="Search by coin or name" />);
    expect(out).toBe(
      '<div class="lit-field-control"><label for="s" class="lt-sr">Search markets</label><div data-part="box"><span data-part="before" aria-hidden="true">⌕</span><input placeholder="Search by coin or name" id="s" type="text"/></div></div>',
    );
  });
  it('cards share the row at their least width', async () => {
    const { CardRow } = await import('./card-row.js');
    const out = html(<CardRow as="section" min="18rem" data-testid="cards" />);
    expect(out).toContain(
      '<section data-testid="cards" class="lt-grid" style="grid-template-columns:repeat(auto-fit, minmax(min(100%, 18rem), 1fr));gap:var(--lit-gap-item)">',
    );
  });
});

describe('GridTable pinFirst', () => {
  it('keeps the first column in view on the panel colour', () => {
    const out = html(<GridTable caption="M" columns={columns} rows={[{ id: 'BTC', price: '1' }]} rowKey={(r) => r.id} pinFirst />);
    expect(out.match(/position:sticky/g)).toHaveLength(2);
    expect(out).toContain('background:var(--lit-solid-bg)');
  });
});
