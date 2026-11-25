import { describe, expect, it } from 'vitest';
import { candlePlaces } from '@intafaced/ui/lit/templates';
import { candleAxis } from './PriceChart';

// The chart's viewBox width (packages/ui b2-charts.tsx W): a candle drawn inside the chart has its body within 0..600.
const W = 600;
const HOUR = 3600;

describe('candleAxis', () => {
  // The indexer's day at 00:10:30 UTC: since is 00:10:30 the day before, and the newest 1-hour candle starts at 00:00.
  const since = Date.UTC(2026, 10, 23, 0, 10, 30) / 1000;
  const newest = Date.UTC(2026, 10, 24, 0, 0, 0) / 1000;
  const oldest = Date.UTC(2026, 10, 23, 0, 0, 0) / 1000;
  const candle = (at: number) => ({ key: String(at), at, open: '1', high: '1.1', low: '0.9', close: '1' });

  it('widens the day to whole candle widths', () => {
    expect(candleAxis(since, 24 * HOUR, HOUR)).toEqual({ start: oldest, seconds: 25 * HOUR, width: HOUR });
    expect(candleAxis(oldest, 24 * HOUR, HOUR)).toEqual({ start: oldest, seconds: 24 * HOUR, width: HOUR });
  });

  it('draws the newest and the oldest candle of the day inside the chart', () => {
    for (const at of [newest, oldest]) {
      const [place] = candlePlaces([candle(at)], candleAxis(since, 24 * HOUR, HOUR));
      expect(place!.body.x).toBeGreaterThanOrEqual(0);
      expect(place!.body.x + place!.body.width).toBeLessThanOrEqual(W);
    }
  });

  it('the raw day drew the newest candle past the chart (the fault this fixes)', () => {
    const [place] = candlePlaces([candle(newest)], { start: since, seconds: 24 * HOUR, width: HOUR });
    expect(place!.body.x).toBeGreaterThan(W);
  });
});
