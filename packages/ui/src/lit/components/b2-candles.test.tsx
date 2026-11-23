import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { candlePlaces, Candles, type Candle } from './b2-charts.js';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const candle = (at: number, open: string, close: string, extra: Partial<Candle> = {}): Candle => ({
  key: String(at),
  at,
  open,
  high: '3',
  low: '1',
  close,
  ...extra,
});

describe('candles', () => {
  it('draws a named chart, each candle rising or falling in words, with its own title and marks', () => {
    const out = html(
      <Candles
        label="Price chart: TESTA in TESTB"
        candles={[
          candle(60, '1.5', '2.5', { title: '00:01: open 1.5, close 2.5', marks: { 'data-testid': 'candle', 'data-time': 't1' } }),
          candle(120, '2.5', '1.5', { title: '00:02: open 2.5, close 1.5', marks: { 'data-testid': 'candle', 'data-time': 't2' } }),
        ]}
        empty="No candles"
        caption="Low 1 · high 3"
        marks={{ 'data-pool': '0xpool' }}
      />,
    );
    expect(out).toContain('<figure class="lt-chart lt-candles" aria-label="Price chart: TESTA in TESTB" data-pool="0xpool">');
    expect(out).toContain('role="img" aria-label="Price chart: TESTA in TESTB"');
    expect(out).toContain(
      '<g class="lt-candle" data-rising="true" data-testid="candle" data-time="t1"><title>00:01: open 1.5, close 2.5</title>',
    );
    expect(out).toContain('<g class="lt-candle" data-rising="false" data-testid="candle" data-time="t2">');
    // The titles are the chart's text equivalent, outside the picture.
    expect(out).toContain('<ul class="lt-sr"><li>00:01: open 1.5, close 2.5</li><li>00:02: open 2.5, close 1.5</li></ul>');
    expect(out).toContain('<figcaption>Low 1 · high 3</figcaption>');
    expect(out).not.toContain('No candles');
  });

  it('a candle that closes at its open counts as rising', () => {
    expect(html(<Candles label="x" candles={[candle(0, '2', '2')]} empty="none" />)).toContain('data-rising="true"');
  });

  it('draws the empty line in place of a chart, keeping the figure named and its marks', () => {
    const out = html(<Candles label="Price chart" candles={[]} empty="No swaps, so no price to draw." marks={{ 'data-pool': '0xp' }} />);
    expect(out).toBe(
      '<figure class="lt-chart lt-candles" aria-label="Price chart" data-empty="true" data-pool="0xp"><p class="lt-candles-empty" role="status">No swaps, so no price to draw.</p></figure>',
    );
    expect(out).not.toContain('<svg');
  });

  it('places candles at their own time on a window, so a quiet stretch is a gap', () => {
    const window = { start: 0, seconds: 600, width: 60 };
    const [a, b] = candlePlaces([candle(0, '1', '2'), candle(300, '2', '1')], window);
    // A 600-unit-wide chart over 600 s: the candle at 300 s sits half way across, after a gap.
    expect(a!.x).toBe(30);
    expect(b!.x).toBe(330);
    expect(b!.body.width).toBe(36);
  });

  it('without a window, sets candles side by side across the chart', () => {
    const places = candlePlaces([candle(0, '1', '2'), candle(60, '2', '1'), candle(120, '1', '3')]);
    expect(places.map((p) => p.x)).toEqual([100, 300, 500]);
  });

  it('puts the highest high at the top and the lowest low at the bottom, and keeps a flat body visible', () => {
    const [p] = candlePlaces([{ key: 'a', open: '2', high: '3', low: '1', close: '2' }]);
    expect(p!.wick.y1).toBeLessThan(p!.wick.y2);
    expect(p!.body.height).toBe(1);
    // A single price with no range still draws inside the chart.
    const [flat] = candlePlaces([{ key: 'b', open: '5', high: '5', low: '5', close: '5' }]);
    expect(Number.isFinite(flat!.wick.y1)).toBe(true);
  });

  it('draws nothing from no candles', () => {
    expect(candlePlaces([])).toEqual([]);
  });
});
