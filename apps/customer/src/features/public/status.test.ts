import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../shared/api';
import { knownMode, marketModesFetcher, modesAsOf } from './status';

const listing = (symbol: string, extra: Record<string, unknown>) => ({ symbol, spot: true, paper: false, ...extra });

describe('knownMode', () => {
  it('describes the modes the lifecycle names and nothing else', () => {
    expect(knownMode('POST_ONLY')).toBe('POST_ONLY');
    expect(knownMode('CANCEL_ONLY')).toBe('CANCEL_ONLY');
    expect(knownMode('LIMIT_ONLY')).toBe('LIMIT_ONLY');
    expect(knownMode('SETTLING')).toBeNull();
    expect(knownMode(null)).toBeNull();
  });
});

describe('marketModesFetcher', () => {
  it('keeps the reported state, and a market with no lifecycle stays unreported (never open)', async () => {
    const body = [
      listing('BTC/USDT', { lifecycle: { state: 'HALTED', reasonCode: 'trade.halted', observedAt: '2026-11-06T07:30:00.000Z' } }),
      listing('ETH/USDT', {}),
      listing('PAPER/USDT', { paper: true, lifecycle: { state: 'OPEN' } }),
    ];
    const api = createApiClient({ fetch: async () => new Response(JSON.stringify(body)) });
    const result = await marketModesFetcher(api)(new AbortController().signal);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data).toEqual([
      { symbol: 'BTC/USDT', state: 'HALTED', reasonCode: 'trade.halted', observedAt: '2026-11-06T07:30:00.000Z', maintenance: null },
      { symbol: 'ETH/USDT', state: null, reasonCode: null, observedAt: null, maintenance: null },
    ]);
  });
});

describe('modesAsOf', () => {
  it('is the oldest observed time, so no row reads fresher than it is, and none when no market reported one', () => {
    const row = (observedAt: string | null) => ({ symbol: 'X/Y', state: 'OPEN', reasonCode: null, observedAt });
    expect(modesAsOf([row('2026-11-06T07:30:00Z'), row('2026-11-06T07:31:00Z'), row(null)])).toBe('2026-11-06T07:30:00.000Z');
    expect(modesAsOf([row(null)])).toBeNull();
    expect(modesAsOf([row('not a time')])).toBeNull();
  });
});
