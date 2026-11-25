import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketTable, MoverTile, type MarketRow } from '../index.js';

const labels = { caption: 'Markets', market: 'Market', price: 'Price', change: '24h', trend: '7 days', volume: 'Volume' };
const btc: MarketRow = {
  id: 'BTC-USD',
  symbol: 'BTC',
  name: 'Bitcoin',
  price: '$97,240.12',
  change: '+1.84%',
  trend: ['1', '2', '3'],
  volume: '$41.2B',
  href: '/trade/spot/BTC-USD',
};

describe('MarketTable', () => {
  it('draws a market with its name, end-aligned figures, its line and a link to its desk', () => {
    const html = renderToStaticMarkup(
      <MarketTable labels={labels} rows={[btc]} action={() => <a href="/t">Trade</a>} actionLabel="Trade" />,
    );
    expect(html).toContain('class="lt-market-symbol">BTC</span>');
    expect(html).toContain('class="lt-market-full">Bitcoin</span>');
    expect(html).toContain('href="/trade/spot/BTC-USD"');
    expect(html).toMatch(/data-label="Price" data-align="end">.*\$97,240\.12/);
    expect(html).toContain('data-direction="up"');
    expect(html).toContain('lt-spark');
    expect(html).toContain('$41.2B');
    expect(html).toContain('class="lt-market-action"');
  });

  it('leaves out the line and volume columns when no row has them', () => {
    const html = renderToStaticMarkup(<MarketTable labels={labels} rows={[{ ...btc, trend: undefined, volume: undefined }]} />);
    expect(html).not.toContain('7 days');
    expect(html).not.toContain('Volume');
  });

  it('holds its shape with placeholder rows while loading, and says it is busy', () => {
    const html = renderToStaticMarkup(<MarketTable labels={labels} rows={[]} loadingRows={3} />);
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/lt-market-bone/g)).toHaveLength(3);
    expect(html).toContain('data-loading="true"');
  });

  it('shows an unknown price as a dash, never a made-up figure', () => {
    expect(renderToStaticMarkup(<MarketTable labels={labels} rows={[{ ...btc, price: null }]} />)).toContain('—');
  });
});

describe('MoverTile', () => {
  it('draws a mover as a link with its change toned by its sign', () => {
    const html = renderToStaticMarkup(<MoverTile symbol="DOGE" price="0.38120" change="−4.94%" trend={['2', '1']} href="/m/DOGE" />);
    expect(html).toContain('<a class="lt-mover" href="/m/DOGE">');
    expect(html).toContain('data-direction="down"');
  });
});

describe('MoverTile quote', () => {
  it('draws the quote side quieter after the symbol, so two pairs of one coin read apart', () => {
    const html = renderToStaticMarkup(<MoverTile symbol="BTC" quote="USDT" price="65,337.43" change="+0.47%" />);
    expect(html).toContain('<span class="lt-market-symbol">BTC</span><span class="lt-market-full">/USDT</span>');
  });
});
