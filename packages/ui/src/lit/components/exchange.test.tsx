import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BookLadder, TradeTape } from './exchange.js';

const labels = { caption: 'Order book', price: 'Price', amount: 'Size', spread: 'Spread' };
const id = (v: string) => v;

describe('BookLadder', () => {
  const html = renderToStaticMarkup(
    <BookLadder
      asks={[
        { price: '100.5', amount: '1', depth: '0.25' },
        { price: '101', amount: '3', depth: '1' },
      ]}
      bids={[
        { price: '100', amount: '2', depth: '0.5' },
        { price: '99.5', amount: '2', depth: '1' },
      ]}
      formatPrice={id}
      formatAmount={id}
      labels={labels}
      spread="0.5 · 50.0 bps"
      rowMarks={(_, side) => ({ 'data-testid': 'row', 'data-side': side })}
    />,
  );
  it('draws asks highest first above the spread, then bids best first', () => {
    const prices = [...html.matchAll(/lt-book-price[^>]*>([\d.]+)</g)].map((m) => m[1]);
    expect(prices).toEqual(['101', '100.5', '100', '99.5']);
    expect(html.indexOf('Spread')).toBeGreaterThan(html.indexOf('100.5'));
    expect(html.indexOf('Spread')).toBeLessThan(html.indexOf('>100<'));
  });
  it("draws each level's depth bar at the ratio it is given, asks deepest first", () => {
    const depths = [...html.matchAll(/--lt-depth:([\d.]+)/g)].map((m) => Number(m[1]));
    expect(depths).toEqual([1, 0.25, 0.5, 1]);
  });
  it('marks every level with its side for the caller', () => {
    expect(html.match(/data-side="ask"/g)).toHaveLength(2);
    expect(html.match(/data-side="bid"/g)).toHaveLength(2);
  });
});

describe('TradeTape', () => {
  it('colours each print by its taker and keeps the price cell to the figure alone', () => {
    const html = renderToStaticMarkup(
      <TradeTape
        prints={[{ id: 't1', price: '100', amount: '0.5', side: 'sell', time: '12:00:01' }]}
        formatPrice={id}
        formatAmount={id}
        labels={{ caption: 'Trades', time: 'Time', price: 'Price', amount: 'Size', side: (s) => (s === 'sell' ? 'Sell' : 'Buy') }}
        priceMarks={{ 'data-testid': 'price' }}
      />,
    );
    expect(html).toContain('data-taker="sell"');
    expect(html).toMatch(/data-testid="price">100<\/td>/);
  });
});
