import { describe, expect, it } from 'vitest';
import type { Candle } from '../../../data/types';
import {
  fillMarkers,
  legendValues,
  movingAverage,
  planUpdate,
  priceFormat,
  shownTick,
  thinRange,
  thinShare,
  toBand,
  toBar,
  toMidPoint,
  toVolumeBar,
  withAlpha,
} from './chart-data';

const candle = (t: number, o: string, h: string, l: string, c: string, v = '1'): Candle => ({ t, o, h, l, c, v, filled: false });
const MIN = 60_000;
const series = [
  candle(0, '10', '12', '9', '11'),
  candle(MIN, '11', '13', '10', '12'),
  candle(2 * MIN, '12', '12', '8', '9'),
  candle(3 * MIN, '9', '10', '9', '10'),
];

describe('chart numbers', () => {
  it('turns a candle into chart bars in seconds', () => {
    expect(toBar(candle(120_000, '65000.5', '65100', '64900', '65050'))).toEqual({
      time: 120,
      open: 65000.5,
      high: 65100,
      low: 64900,
      close: 65050,
    });
  });

  it('colours volume by candle direction', () => {
    const colors = { up: 'U', down: 'D' };
    expect(toVolumeBar(series[0]!, colors).color).toBe('U');
    expect(toVolumeBar(series[2]!, colors).color).toBe('D');
  });

  it('averages the closes and leaves the first period-1 candles empty', () => {
    expect(movingAverage(series, 3)).toEqual([
      { time: 120, value: (11 + 12 + 9) / 3 },
      { time: 180, value: (12 + 9 + 10) / 3 },
    ]);
    expect(movingAverage(series, 5)).toEqual([]);
  });

  it('derives the axis format from the tick size, with thousands separators', () => {
    expect(priceFormat('0.01').minMove).toBe(0.01);
    expect(priceFormat('0.01').formatter(65000)).toBe('65,000.00');
    expect(priceFormat('0.00001').formatter(0.1234567)).toBe('0.12346');
    expect(priceFormat('1').formatter(1234.5)).toBe('1,235');
    // The person's locale groups and points the digits (J-charts-desk-07 #7); English stays the default.
    expect(priceFormat('0.01', 'fr').formatter(65000)).toBe('65\u202f000,00');
    expect(priceFormat('0.01', 'es').formatter(65000.5)).toBe('65.000,50');
  });
});

describe('fillMarkers', () => {
  it('puts a buy under and a sell over the candle the fill fell in, sorted, skipping fills off screen', () => {
    const marks = fillMarkers(
      [
        { at: 2 * MIN + 5_000, side: 'sell' },
        { at: MIN + 1_000, side: 'buy' },
        { at: 99 * MIN, side: 'buy' },
      ],
      series,
      MIN,
      { up: 'U', down: 'D' },
      { buy: 'B', sell: 'S' },
    );
    expect(marks).toEqual([
      { time: 60, position: 'belowBar', shape: 'arrowUp', color: 'U', text: 'B' },
      { time: 120, position: 'aboveBar', shape: 'arrowDown', color: 'D', text: 'S' },
    ]);
  });
});

describe('legendValues', () => {
  it('writes the OHLC line and the signed change from exact decimals', () => {
    const legend = legendValues(candle(0, '83351.0', '83351.0', '83253.2', '83281.8'), '0.1');
    expect(legend.open).toBe('83,351.0');
    expect(legend.close).toBe('83,281.8');
    expect(legend.direction).toBe('down');
    expect(legend.change).toBe('−69.2 (−0.08%)');
  });

  it('marks a rise with a plus', () => {
    expect(legendValues(candle(0, '100', '110', '100', '110'), '0.01').change).toBe('+10.00 (+10.00%)');
  });

  it('writes the numbers as the person’s locale does', () => {
    const legend = legendValues(candle(0, '83351.0', '83351.0', '83253.2', '83281.8'), '0.1', 'fr');
    expect(legend.open).toBe('83\u202f351,0');
    expect(legend.close).toBe('83\u202f281,8');
    expect(legend.change).toMatch(/^−69,2 \(−0,08\s?%\)$/);
  });
});

describe('planUpdate', () => {
  it('updates when only the newest candle changed or one was added', () => {
    const grown = [...series.slice(0, 3), candle(3 * MIN, '9', '11', '9', '11'), candle(4 * MIN, '11', '11', '11', '11')];
    expect(planUpdate(series, grown)).toEqual({ kind: 'update', from: 3 });
    expect(planUpdate(series, series)).toEqual({ kind: 'update', from: 3 });
  });

  it('resets when the window moved or history changed', () => {
    expect(planUpdate(null, series)).toEqual({ kind: 'reset' });
    expect(planUpdate(series, series.slice(1))).toEqual({ kind: 'reset' });
    const changed = [candle(0, '10', '12', '9', '11.5'), ...series.slice(1)];
    expect(planUpdate(series, changed)).toEqual({ kind: 'reset' });
  });
});

describe('shownTick', () => {
  it('draws a coin priced by significant figures at five of them, never finer than its tick', () => {
    expect(shownTick('0.00000001', '4.5342')).toBe('0.0001');
    expect(shownTick('0.1', '58847')).toBe('1');
    expect(shownTick('0.00000001', '0.0021840')).toBe('0.0000001');
    expect(shownTick('0.01', '4.5342')).toBe('0.01');
    expect(shownTick('0.00000001', null)).toBe('0.00000001');
  });
});

describe('a thin market: candles that only trade across the pair’s own spread', () => {
  // Testnet PURR-USDC on 25 Nov: every trade at the best bid (4.5342) or the best ask (4.5795).
  const bid = '4.5342';
  const ask = '4.5795';
  const purr = [
    candle(0, bid, ask, bid, ask),
    candle(MIN, ask, ask, ask, ask),
    candle(2 * MIN, ask, ask, bid, bid),
    candle(3 * MIN, bid, bid, bid, bid),
  ];

  it('counts the traded candles inside the spread when they are most of them', () => {
    expect(thinShare(purr, bid, ask)).toEqual({ inside: 4, total: 4 });
  });

  it('leaves out forward-filled candles, which traded nothing', () => {
    const filled: Candle = { ...candle(4 * MIN, ask, ask, ask, ask), filled: true };
    expect(thinShare([...purr, filled], bid, ask)).toEqual({ inside: 4, total: 4 });
  });

  it('is null once most candles move outside the spread, so candles come back', () => {
    const moving = [candle(0, '4.40', '4.60', '4.38', '4.55'), candle(MIN, '4.55', '4.70', '4.50', '4.66'), purr[1]!];
    expect(thinShare(moving, bid, ask)).toBeNull();
  });

  it('is null with no traded candle', () => {
    expect(thinShare([], bid, ask)).toBeNull();
  });

  it('draws each candle as a box from its low to its high, and its mid as the line', () => {
    expect(toBand(purr[0]!)).toEqual({ time: 0, open: 4.5795, high: 4.5795, low: 4.5342, close: 4.5342 });
    expect(toMidPoint(purr[0]!).value).toBeCloseTo(4.55685, 6);
    expect(toMidPoint(purr[3]!).value).toBe(4.5342);
  });

  it('keeps the axis at least 5% either side of the last price, wider when the data is', () => {
    const r = thinRange(4.5342, { minValue: 4.5342, maxValue: 4.5795 });
    expect(r.minValue).toBeCloseTo(4.30749, 5);
    expect(r.maxValue).toBeCloseTo(4.76091, 5);
    expect(thinRange(100, { minValue: 50, maxValue: 200 })).toEqual({ minValue: 50, maxValue: 200 });
    expect(thinRange(100, null)).toEqual({ minValue: 95, maxValue: 105 });
  });

  it('turns a hex colour into the band’s soft fill, and leaves any other colour as it is', () => {
    expect(withAlpha('#909090', 0.08)).toBe('rgba(144, 144, 144, 0.08)');
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
    expect(withAlpha('rgb(1, 2, 3)', 0.08)).toBe('rgb(1, 2, 3)');
  });
});
