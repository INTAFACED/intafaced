import { describe, expect, it } from 'vitest';
import type { Candle } from '../../data/types';
import { barsCsv, chartLink, fileStem, visibleBars } from './chart-files';

// TEST bars, not market data.
const bar = (t: number, c: string, filled = false): Candle => ({ t, o: c, h: c, l: c, c, v: '0.5', filled });

describe('chart files', () => {
  it('writes one row per bar in UTC with a header naming market, interval and the viewer’s zone', () => {
    const csv = barsCsv([bar(0, '100.10'), bar(60_000, '=1', true)], 'BTC/USDT', '1m', 'Europe/Berlin').split('\n');
    expect(csv[0]).toContain('BTC/USDT 1m bars; times are UTC; viewer time zone Europe/Berlin');
    expect(csv[1]).toBe('time_utc,open,high,low,close,volume,filled');
    expect(csv[2]).toBe('1970-01-01T00:00:00.000Z,100.10,100.10,100.10,100.10,0.5,no');
    // A formula-looking cell is kept as text.
    expect(csv[3]).toBe("1970-01-01T00:01:00.000Z,'=1,'=1,'=1,'=1,0.5,yes");
  });

  it('guards only formula starts: a negative price is written as it is', () => {
    const csv = barsCsv([bar(0, '-1.5'), bar(60_000, '+2'), bar(120_000, '@x')], 'BTC/USDT', '1m', 'UTC').split('\n');
    expect(csv[2]).toBe('1970-01-01T00:00:00.000Z,-1.5,-1.5,-1.5,-1.5,0.5,no');
    expect(csv[3]).toBe("1970-01-01T00:01:00.000Z,'+2,'+2,'+2,'+2,0.5,no");
    expect(csv[4]).toBe("1970-01-01T00:02:00.000Z,'@x,'@x,'@x,'@x,0.5,no");
  });

  it('takes the bars in the visible range only', () => {
    const bars = [bar(0, '1'), bar(1, '2'), bar(2, '3'), bar(3, '4')];
    // A bar half off the edge is left out; one more than half is in.
    expect(visibleBars(bars, { from: 0.6, to: 2.2 }).map((b) => b.c)).toEqual(['2', '3']);
    expect(visibleBars(bars, { from: 0.4, to: 2.5 }).map((b) => b.c)).toEqual(['1', '2', '3', '4']);
    expect(visibleBars(bars, { from: 1, to: 2 }).map((b) => b.c)).toEqual(['2', '3']);
    expect(visibleBars(bars, { from: -5, to: 100 })).toHaveLength(4);
    expect(visibleBars(bars, null)).toBe(bars);
  });

  it('links to the chart by market, interval and style only', () => {
    expect(chartLink('https://x.test', 'BTC/USDT', '1h', 'line')).toBe('https://x.test/charts/BTC-USDT?interval=1h&style=line');
    expect(fileStem('BTC/USDT', '15m')).toBe('chart-BTC-USDT-15m');
  });
});
