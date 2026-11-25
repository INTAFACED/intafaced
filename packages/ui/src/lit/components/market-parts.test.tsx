import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketHeader, MarketTable, MoverTile, StatStrip, type MarketRow } from '../index.js';

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

describe('StatStrip', () => {
  it('draws label-over-figure pairs, keeps test ids, tones by sign and dashes an unknown', () => {
    const html = renderToStaticMarkup(
      <StatStrip
        label="Contract"
        cells={[
          { key: 'mark', label: 'Mark', value: '97,240.12', 'data-testid': 'mark' },
          { key: 'funding', label: 'Funding 1h', value: '+0.0012%', tone: 'up' },
          { key: 'oi', label: 'Open interest', value: null },
          { key: 'family', label: 'Family', value: 'Perpetual', num: false },
        ]}
      />,
    );
    expect(html).toContain('<dl class="lt-stat-strip" aria-label="Contract">');
    expect(html).toContain('<dt>Mark</dt><dd class="lt-num" dir="ltr" data-testid="mark">97,240.12</dd>');
    expect(html).toContain('data-direction="up"');
    expect(html).toContain('<dt>Open interest</dt><dd class="lt-num" dir="ltr">—</dd>');
    expect(html).toContain('<dt>Family</dt><dd>Perpetual</dd>');
  });
});

describe('MarketHeader', () => {
  it('names the market, draws the last price with its change, then its figures and aside', () => {
    const html = renderToStaticMarkup(
      <MarketHeader
        label="Market"
        asset="BTC"
        symbol="BTC-PERP"
        name="Bitcoin perpetual"
        badges={<span className="lt-test">TEST</span>}
        price="97,240.12"
        change="+1.84%"
        priceTestId="venue-last"
        stats={[{ key: 'bid', label: 'Best bid', value: '97,240.00' }]}
        aside="As of 10:41"
        data-testid="market-header"
      />,
    );
    expect(html).toContain('<section class="lt-market-header" aria-label="Market" data-testid="market-header">');
    expect(html).toContain('BTC-PERP');
    expect(html).toContain('data-testid="venue-last"');
    expect(html).toContain('data-direction="up"');
    expect(html).toContain('<dt>Best bid</dt>');
    expect(html).toContain('As of 10:41');
  });

  it('draws a dash, never a zero, when there is no print', () => {
    const html = renderToStaticMarkup(<MarketHeader label="Market" asset="PURR" symbol="PURR/USDC" price={null} change={null} />);
    expect(html).toContain('data-unknown="true"');
    expect(html).not.toContain('lt-stat-strip');
  });
});

describe('MoverTile quote', () => {
  it('draws the quote side quieter after the symbol, so two pairs of one coin read apart', () => {
    const html = renderToStaticMarkup(<MoverTile symbol="BTC" quote="USDT" price="65,337.43" change="+0.47%" />);
    expect(html).toContain('<span class="lt-market-symbol">BTC</span><span class="lt-market-full">/USDT</span>');
  });
});

describe('big figures draw their cents as the look sets them', () => {
  it('splits two-place cents on a tile price, keeps a coin price whole, and leaves a table price full', () => {
    expect(renderToStaticMarkup(<MoverTile symbol="BTC" price="$64,827.55" change="+0.47%" />)).toContain(
      '$64,827<span class="lt-cents">.55</span>',
    );
    expect(renderToStaticMarkup(<MoverTile symbol="PURR" price="0.21840" change="+12.46%" />)).toContain('>0.21840</span>');
    const table = renderToStaticMarkup(<MarketTable labels={labels} rows={[btc]} />);
    expect(table).toContain('$97,240.12');
    expect(table).not.toContain('lt-cents');
  });
});
