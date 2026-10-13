import { describe, expect, it } from 'vitest';
import { AgentError } from '../errors.js';
import { readLiveSpotTickers, type SpotTickersPort } from './spot-tickers-port.js';

const sample = {
  marketId: 'btc-usdt',
  last: '100',
  volume24h: '1000',
  change24hBps: 50,
  asOf: '2026-08-07T11:59:30.000Z',
  maxAgeMs: 120_000,
};

describe('readLiveSpotTickers', () => {
  it('unset port is no_live_tickers — not a fake quote board', async () => {
    const r = await readLiveSpotTickers(undefined);
    expect(r).toEqual({ ok: false, reason: 'no_live_tickers' });
  });

  it('empty sample is no_live_tickers — silence is not a zero-filled ticker', async () => {
    const port: SpotTickersPort = { sample: async () => [] };
    expect(await readLiveSpotTickers(port)).toEqual({ ok: false, reason: 'no_live_tickers' });
  });

  it('throwing sample is no_live_tickers', async () => {
    const port: SpotTickersPort = {
      sample: async () => {
        throw new Error('spot plane down');
      },
    };
    expect(await readLiveSpotTickers(port)).toEqual({ ok: false, reason: 'no_live_tickers' });
  });

  it('returns port samples when present', async () => {
    const port: SpotTickersPort = { sample: async () => [sample] };
    expect(await readLiveSpotTickers(port)).toEqual({ ok: true, tickers: [sample] });
  });

  it('a sample whose only last is null or blank is no_live_tickers', async () => {
    const port: SpotTickersPort = {
      sample: async () => [
        { ...sample, last: null },
        { ...sample, marketId: 'eth-usdt', last: '' },
        { ...sample, marketId: 'sol-usdt', last: ' \t' },
      ],
    };
    expect(await readLiveSpotTickers(port)).toEqual({ ok: false, reason: 'no_live_tickers' });
  });

  it('keeps a positive last and drops a blank last from the same sample', async () => {
    const blank = { ...sample, marketId: 'eth-usdt', last: '  ' };
    const port: SpotTickersPort = { sample: async () => [sample, blank] };
    expect(await readLiveSpotTickers(port)).toEqual({ ok: true, tickers: [sample] });
  });

  it('tickers_limit_unset from the HTTP client stays named — not no_live_tickers', async () => {
    const port: SpotTickersPort = {
      sample: async () => {
        throw new AgentError(
          'Tickers page limit is unset — pass limit (never invent 500)',
          'agents.tickers_limit_unset',
          'agents.scanner.tickers_limit_unset',
        );
      },
    };
    expect(await readLiveSpotTickers(port)).toEqual({ ok: false, reason: 'tickers_limit_unset' });
  });
});
