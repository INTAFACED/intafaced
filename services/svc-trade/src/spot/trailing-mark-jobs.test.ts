import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { QuotedMarkSource } from '../futures/liquidation-tick.js';
import { MatchingNoBookError, MatchingUnavailableError, type EngineMarkResult } from './matching-client.js';
import { startTrailingMarkJobs, TrailingMarkJobsUnsetError, TRADE_TRAILING_MARK_JOBS_INTERVAL_UNSET } from './trailing-mark-jobs.js';

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';

function sourceOf(prices: Record<string, string | null | Error>): QuotedMarkSource {
  return {
    async markPrice() {
      return null;
    },
    async quote({ marketId, at }) {
      const p = prices[marketId];
      if (p instanceof Error) throw p;
      if (p == null) return null;
      return { marketId, price: parseAmount(p), asOf: at, quality: 'mid', provenance: 'depth' };
    },
  };
}

function poster(over: (marketId: string) => EngineMarkResult | Error = () => ({ accepted: true, applied: false, rejected: null })) {
  const posted: Array<{ marketId: string; mark: string }> = [];
  return {
    posted,
    postMark: async (marketId: string, mark: string) => {
      posted.push({ marketId, mark });
      const r = over(marketId);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('trailing mark pump', () => {
  it('posts the labelled mark for each configured market, formatted as a decimal string', async () => {
    const p = poster();
    const job = startTrailingMarkJobs({
      config: { enabled: false, intervalMs: null, marketIds: [M1, M2] },
      source: sourceOf({ [M1]: '100.5', [M2]: '7' }),
      postMark: p.postMark,
    });
    const results = await job.tick();
    expect(p.posted).toEqual([
      { marketId: M1, mark: '100.5' },
      { marketId: M2, mark: '7' },
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['posted', 'posted']);
  });

  it('a market with no usable mark is skipped and nothing is posted for it', async () => {
    const p = poster();
    const job = startTrailingMarkJobs({
      config: { enabled: false, intervalMs: null, marketIds: [M1, M2] },
      source: sourceOf({ [M1]: null, [M2]: '7' }),
      postMark: p.postMark,
    });
    const results = await job.tick();
    expect(p.posted).toEqual([{ marketId: M2, mark: '7' }]);
    expect(results.map((r) => r.outcome)).toEqual(['no_mark', 'posted']);
  });

  it('a throwing mark source skips that market and keeps going', async () => {
    const p = poster();
    const errors: unknown[] = [];
    const job = startTrailingMarkJobs({
      config: { enabled: false, intervalMs: null, marketIds: [M1, M2] },
      source: sourceOf({ [M1]: new Error('book read failed'), [M2]: '7' }),
      postMark: p.postMark,
      onError: (_n, e) => errors.push(e),
    });
    const results = await job.tick();
    expect(results.map((r) => r.outcome)).toEqual(['unreachable', 'posted']);
    expect(errors).toHaveLength(1);
    expect(p.posted).toEqual([{ marketId: M2, mark: '7' }]);
  });

  it('a market with no book yet is quiet: no mark, no error', async () => {
    const p = poster();
    const errors: unknown[] = [];
    const job = startTrailingMarkJobs({
      config: { enabled: false, intervalMs: null, marketIds: [M1] },
      source: sourceOf({ [M1]: new MatchingNoBookError(M1) }),
      postMark: p.postMark,
      onError: (_n, e) => errors.push(e),
    });
    expect((await job.tick())[0]!.outcome).toBe('no_mark');
    expect(errors).toEqual([]);
    expect(p.posted).toEqual([]);
  });

  it('an unreachable engine skips that market and keeps going', async () => {
    const p = poster((id) => (id === M1 ? new MatchingUnavailableError('down') : { accepted: true, applied: true, rejected: null }));
    const job = startTrailingMarkJobs({
      config: { enabled: false, intervalMs: null, marketIds: [M1, M2] },
      source: sourceOf({ [M1]: '100', [M2]: '7' }),
      postMark: p.postMark,
      onError: () => {},
    });
    const results = await job.tick();
    expect(results).toEqual([
      { marketId: M1, outcome: 'unreachable', applied: false },
      { marketId: M2, outcome: 'posted', applied: true },
    ]);
  });

  it('a refused mark (halted market) is reported as refused, not applied', async () => {
    const p = poster(() => ({ accepted: false, applied: false, rejected: { code: 'market_halted', message: 'halted' } }));
    const job = startTrailingMarkJobs({
      config: { enabled: false, intervalMs: null, marketIds: [M1] },
      source: sourceOf({ [M1]: '100' }),
      postMark: p.postMark,
    });
    expect((await job.tick())[0]).toEqual({ marketId: M1, outcome: 'refused', applied: false });
  });

  it('any other failure from the engine call is not swallowed', async () => {
    const p = poster(() => new TypeError('bug'));
    const job = startTrailingMarkJobs({
      config: { enabled: false, intervalMs: null, marketIds: [M1] },
      source: sourceOf({ [M1]: '100' }),
      postMark: p.postMark,
    });
    await expect(job.tick()).rejects.toBeInstanceOf(TypeError);
  });

  it('is not scheduled when disabled, or when enabled with no markets', () => {
    const base = { source: sourceOf({}), postMark: poster().postMark };
    const off = startTrailingMarkJobs({ ...base, config: { enabled: false, intervalMs: 1000, marketIds: [M1] } });
    const empty = startTrailingMarkJobs({ ...base, config: { enabled: true, intervalMs: 1000, marketIds: [' ', ''] } });
    expect(off.host.list()).toEqual([]);
    expect(empty.host.list()).toEqual([]);
  });

  it('enabled with markets and a blank interval refuses; the tick rate is never invented', () => {
    const base = { source: sourceOf({}), postMark: poster().postMark };
    for (const intervalMs of [null, 0, -5, 1.5]) {
      expect(() => startTrailingMarkJobs({ ...base, config: { enabled: true, intervalMs, marketIds: [M1] } })).toThrow(
        TrailingMarkJobsUnsetError,
      );
    }
    try {
      startTrailingMarkJobs({ ...base, config: { enabled: true, intervalMs: null, marketIds: [M1] } });
    } catch (err) {
      expect((err as TrailingMarkJobsUnsetError).code).toBe(TRADE_TRAILING_MARK_JOBS_INTERVAL_UNSET);
    }
  });

  it('is scheduled when enabled with markets and an interval', () => {
    const job = startTrailingMarkJobs({
      source: sourceOf({}),
      postMark: poster().postMark,
      config: { enabled: true, intervalMs: 1000, marketIds: [M1] },
    });
    expect(job.host.list()).toEqual(['spot.trailing_mark']);
    job.stop();
    expect(job.host.list()).toEqual([]);
  });
});
