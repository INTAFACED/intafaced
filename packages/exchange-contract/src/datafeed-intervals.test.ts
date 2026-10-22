import { describe, expect, it } from 'vitest';
import { DATAFEED_INTERVALS, DATAFEED_INTERVAL_MS, bucketStart, type DatafeedInterval } from '@intafaced/contracts/datafeed';
import { TIMEFRAMES, TIMEFRAME_MS, type Timeframe } from './schemas.js';

describe('datafeed contract uses the exchange TIMEFRAMES identifiers (C-embed-feed-ops-01)', () => {
  it('same identifiers, same order', () => {
    expect([...DATAFEED_INTERVALS]).toEqual([...TIMEFRAMES]);
  });
  it('same bucket width and bucket start as svc-trade for every interval', () => {
    const samples = [0, 1, 59_999, Date.UTC(2026, 9, 22, 4, 0, 0), Date.UTC(2026, 1, 28, 23, 59, 59, 999), 1_790_000_000_123];
    for (const i of TIMEFRAMES) {
      expect(DATAFEED_INTERVAL_MS[i]).toBe(TIMEFRAME_MS[i]);
      for (const t of samples) expect(bucketStart(i, t)).toBe(Math.floor(t / TIMEFRAME_MS[i]) * TIMEFRAME_MS[i]);
    }
  });
  it('types are mutually assignable', () => {
    const a: Timeframe = '1h' satisfies DatafeedInterval;
    const b: DatafeedInterval = a;
    expect(b).toBe('1h');
  });
});
