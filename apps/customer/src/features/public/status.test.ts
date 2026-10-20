import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../shared/api';
import { knownMode, marketModesFetcher } from './status';

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
      listing('BTC/USDT', { lifecycle: { state: 'HALTED', reasonCode: 'trade.halted' } }),
      listing('ETH/USDT', {}),
      listing('PAPER/USDT', { paper: true, lifecycle: { state: 'OPEN' } }),
    ];
    const api = createApiClient({ fetch: async () => new Response(JSON.stringify(body)) });
    const result = await marketModesFetcher(api)(new AbortController().signal);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data).toEqual([
      { symbol: 'BTC/USDT', state: 'HALTED', reasonCode: 'trade.halted' },
      { symbol: 'ETH/USDT', state: null, reasonCode: null },
    ]);
  });
});
