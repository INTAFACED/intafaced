import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from './select';

// Server rendering has no browser store or session.
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../../features/session/session', () => ({ useSession: () => ({ session: null }) }));

import { MarketsTable } from './MarketsTable';

const entry = (base: string, last: string, change: string): Entry => ({
  market: {
    symbol: `${base}-USDT`,
    base,
    quote: 'USDT',
    orderable: true,
    tickSize: '0.01',
    lotSize: '0.0001',
    minAmount: null,
    listedAt: null,
  },
  ticker: {
    symbol: `${base}-USDT`,
    last,
    bid: null,
    ask: null,
    open24h: null,
    high24h: '200',
    low24h: '1',
    change24h: null,
    changePct24h: change,
    baseVolume24h: '10',
    quoteVolume24h: null,
    windowStart: null,
    source: 'server',
  },
});

const rows = [entry('BTC', '100.5', '0.0123'), entry('ETH', '50.25', '-0.02')];

describe('the markets table on the kit', () => {
  it('keeps every mark its tests find it by: header, numeric headers and cells, rows, names', () => {
    const html = renderToStaticMarkup(
      <MarketsTable
        label="Markets"
        entries={rows}
        mode="pro"
        columns={['name', 'price', 'change', 'spark', 'range', 'action']}
        sort={null}
        onSortChange={() => {}}
      />,
    );
    expect(html).toContain('<table class="lt-table" data-mode="pro">');
    expect(html).toContain('<caption class="lt-sr">Markets</caption>');
    expect(html).toContain('<tr data-testid="mkt-header">');
    expect(html).toContain('<th data-col="price" data-testid="mkt-head--num" scope="col" data-align="end" aria-sort="none">');
    expect(html).toContain('aria-label="Sort by Price"');
    expect(html).toMatch(/<tr data-testid="mkt-row" data-symbol="BTC-USDT"/);
    expect(html).toContain('<td data-col="change" data-testid="mkt-cell--num"');
    expect(html).toContain('<td data-col="range" data-label="24h range"');
    expect(html).toContain(
      '<span data-testid="mkt-name__ticker">BTC<span data-testid="mkt-name__quote" class="lt-hint">/USDT</span></span>',
    );
    expect(html).toContain('data-testid="mkt-range__marker"');
    expect(html).toContain('data-testid="mkt-range__ends"');
    expect(html).toContain('aria-label="Trade BTC/USDT"');
    expect(html).toMatch(/data-dir="down"[^>]*>.*▼/);
    // Nothing outside the kit's own classes.
    expect(html).not.toMatch(/class="[^"]*\bmkt-/);
  });

  it('keeps its header and draws placeholders in the rows while loading, and says it is busy', () => {
    const html = renderToStaticMarkup(<MarketsTable label="Markets" entries={[]} mode="pro" loading skeletonRows={3} empty="none" />);
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/data-testid="mkt-row"/g)).toHaveLength(3);
    expect(html).toContain('lt-ghost');
    expect(html).not.toContain('mkt-empty');
  });

  it("says why it is empty in its own place, and sorts in the room's order", () => {
    expect(renderToStaticMarkup(<MarketsTable label="Markets" entries={[]} mode="pro" empty="No markets" />)).toContain(
      '<tr data-empty=""><td colSpan="7"><div data-testid="mkt-empty">No markets</div></td></tr>',
    );
    const html = renderToStaticMarkup(
      <MarketsTable label="Markets" entries={rows} mode="pro" sort={{ key: 'price', dir: 'desc' }} onSortChange={() => {}} />,
    );
    expect(html).toContain('<th data-col="price" data-testid="mkt-head--num" scope="col" data-align="end" aria-sort="descending">');
  });
});
