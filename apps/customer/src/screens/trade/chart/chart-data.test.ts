import { describe, expect, it } from 'vitest';
import type { Candle } from '../../../data/types';
import { fillMarkers, legendValues, movingAverage, planUpdate, priceFormat, toBar, toVolumeBar } from './chart-data';

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
