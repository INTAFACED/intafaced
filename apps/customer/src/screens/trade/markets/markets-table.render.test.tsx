import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { betaRoomList } from '../../../app/beta-volt';
import { betaHidden } from '../../../app/feature-registry';
import { rooms } from '../../../app/navigation';
import { voltCount } from '../../../app/volt-count';
import { appPath } from '../../../app/beta-links';
import type { Entry } from './select';

// Server rendering has no browser store or session.
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../../features/session/session', () => ({ useSession: () => ({ session: null }) }));

import { MarketsTable } from './MarketsTable';
import { Board } from './Board';

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
    expect(html).toMatch(/data-dir="down"[^>]*><span class="lt-arrow lt-arrow-down" aria-hidden="true" data-arrow="down"><\/span>/);
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

// The beta's build draws a link to a room it hides as nothing, with every word inside it (src/app/beta-links.ts).
// With the beta's own room list, a row must name its pair outside any link the beta drops. The spot desk is in Volt,
// so its link stays; a room the beta hides still may not carry a pair's name.
describe("the markets table and top cards in the beta's build", () => {
  afterEach(() => vi.unstubAllGlobals());
  const droppedLinks = (html: string) =>
    [...html.matchAll(/<a [^>]*href="([^"]+)"/g)]
      .map((match) => match[1]!)
      .filter((href) => {
        const path = appPath(href.replaceAll('&amp;', '&'));
        return path !== undefined && betaHidden(path);
      });

  it('names every pair, in Pro, with no link the beta would drop', () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaRoomList(voltCount().rooms, rooms));
    expect(betaHidden('/trade/spot/BTC-USDT')).toBe(false); // the desk is in Volt: the beta shows it
    const table = renderToStaticMarkup(
      <MarketsTable label="Markets" entries={rows} mode="pro" columns={['name', 'price', 'action']} sort={null} onSortChange={() => {}} />,
    );
    // The board above the list (hero and movers) replaced the top cards; the same guard holds for its links.
    const board = renderToStaticMarkup(<Board entries={rows} mode="pro" />);
    for (const html of [table, board]) {
      expect(droppedLinks(html)).toEqual([]);
      expect(html).toMatch(/BTC<span[^>]*>\/USDT<\/span>/);
      expect(html).toMatch(/ETH<span[^>]*>\/USDT<\/span>/);
    }
    expect(board.match(/data-testid="mkt-mover"/g)).toHaveLength(2);
    expect(board).toMatch(/href="\/trade\/spot\/BTC-USDT"/);
  });
});
