import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { candleGaps, FeedHealthDesk, feedStateOf } from './feed-health.js';

const at = (iso: string) => new Date(iso);
const ms = (iso: string) => Date.parse(iso);

describe('feedStateOf (J-charts-desk-18 #1)', () => {
  const now = at('2026-11-07T09:00:40Z');

  it('reads a 40 second old stream as stale past a 30 s boundary, with its age and last tick', () => {
    expect(feedStateOf(at('2026-11-07T09:00:00Z'), 30, now)).toEqual({
      lastTickAt: '2026-11-07T09:00:00.000Z',
      ageSeconds: 40,
      state: 'stale',
    });
  });

  it('reads a stream within the boundary as live, and one exactly at it as live', () => {
    expect(feedStateOf(at('2026-11-07T09:00:30Z'), 30, now).state).toBe('live');
    expect(feedStateOf(at('2026-11-07T09:00:10Z'), 30, now).state).toBe('live');
  });

  it('judges nothing while the boundary is blank, and still shows the age', () => {
    expect(feedStateOf(at('2026-11-07T09:00:00Z'), null, now)).toEqual({
      lastTickAt: '2026-11-07T09:00:00.000Z',
      ageSeconds: 40,
      state: 'threshold_not_set',
    });
  });

  it('says a market with no tick has none, never age zero', () => {
    expect(feedStateOf(null, 30, now)).toEqual({ lastTickAt: null, ageSeconds: null, state: 'no_ticks' });
  });
});

describe('candleGaps (J-charts-desk-18 #1 drill-down)', () => {
  it('lists runs of empty closed minutes newest first, and leaves the open minute out', () => {
    const filled = new Set([ms('2026-11-07T09:00:00Z'), ms('2026-11-07T09:03:00Z')]);
    const { gaps, truncated } = candleGaps(filled, ms('2026-11-07T08:00:00Z'), ms('2026-11-07T09:00:00Z'), ms('2026-11-07T09:06:30Z'));
    expect(truncated).toBe(false);
    expect(gaps).toEqual([
      { from: '2026-11-07T09:04:00.000Z', to: '2026-11-07T09:06:00.000Z', minutes: 2 },
      { from: '2026-11-07T09:01:00.000Z', to: '2026-11-07T09:03:00.000Z', minutes: 2 },
    ]);
  });

  it('starts at the first tick when it is inside the window: before a market traded is not a gap', () => {
    const filled = new Set([ms('2026-11-07T09:05:00Z')]);
    const { gaps } = candleGaps(filled, ms('2026-11-07T09:05:10Z'), ms('2026-11-07T08:00:00Z'), ms('2026-11-07T09:07:01Z'));
    expect(gaps).toEqual([{ from: '2026-11-07T09:06:00.000Z', to: '2026-11-07T09:07:00.000Z', minutes: 1 }]);
  });

  it('has no gaps for a market that never traded', () => {
    expect(candleGaps(new Set(), null, 0, ms('2026-11-07T09:00:00Z'))).toEqual({ gaps: [], truncated: false });
  });

  it('caps the list and says it did', () => {
    // Every other minute filled over 500 minutes: 250 one-minute gaps.
    const start = ms('2026-11-07T00:00:00Z');
    const filled = new Set(Array.from({ length: 250 }, (_, i) => start + i * 120_000));
    const { gaps, truncated } = candleGaps(filled, start, start, start + 500 * 60_000);
    expect(gaps).toHaveLength(200);
    expect(truncated).toBe(true);
  });
});

describe('FeedHealthDesk scopes', () => {
  const desk = new FeedHealthDesk({
    sql: (() => {
      throw new Error('no read without the scope');
    }) as never,
    now: () => new Date(),
  });
  const customer = { sub: 'u', scopes: ['trade:read'] } as unknown as Principal;

  it('refuses a caller without admin:read before reading anything', async () => {
    await expect(desk.list(customer)).rejects.toThrow();
    await expect(desk.market(customer, { symbol: 'BTC/USDT', gapWindowMinutes: 60 })).rejects.toThrow();
  });
});
