import { describe, expect, it } from 'vitest';
import { DATAFEED_INTERVALS, type DatafeedInterval } from '@intafaced/contracts/datafeed';
import { TIMEFRAMES, type Timeframe } from './schemas.js';

describe('datafeed contract uses the exchange TIMEFRAMES identifiers (C-embed-feed-ops-01)', () => {
  it('same identifiers, same order', () => {
    expect([...DATAFEED_INTERVALS]).toEqual([...TIMEFRAMES]);
  });
  it('types are mutually assignable', () => {
    const a: Timeframe = '1h' satisfies DatafeedInterval;
    const b: DatafeedInterval = a;
    expect(b).toBe('1h');
  });
});
