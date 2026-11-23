import { describe, expect, it } from 'vitest';
import type { QuantBacktestTrade } from '@intafaced/contracts';
import { monteCarlo, roundTripsOf } from './montecarlo.js';

// RC-algo-dev-04 (J-algo-dev-16 #3): seeded resampling of a finished run's closed round trips.
const t = (side: 'buy' | 'sell', qty: string, price: string, fee = '0'): QuantBacktestTrade => ({
  ts: '2026-11-15T00:00:00.000Z',
  side,
  reason: 'signal',
  qty,
  barPrice: price,
  price,
  fee,
  slippage: '0',
});

const TRADES = [
  t('buy', '1', '100', '1'),
  t('sell', '1', '110', '1'), // +8
  t('buy', '1', '110'),
  t('sell', '1', '90'), // -20
  t('buy', '2', '90'),
  t('sell', '1', '95'),
  t('sell', '1', '100'), // +15
  t('buy', '1', '100'), // still open: not a closed trip
];

describe('round trips', () => {
  it('nets each closed trip against its average entry, less its fees; an open position is no trip', () => {
    expect(roundTripsOf(TRADES).map(String)).toEqual([8n, -20n, 15n].map((n) => String(n * 10n ** 18n)));
  });
  it('a short trip gains when the price falls', () => {
    expect(roundTripsOf([t('sell', '1', '100'), t('buy', '1', '80')]).map(String)).toEqual([String(20n * 10n ** 18n)]);
  });
});

describe('monteCarlo', () => {
  const base = { trades: TRADES, startCash: '100', ruinLevel: '80', runs: 500, minTrades: 3 };

  it('the same seed gives the same distribution, another seed another', () => {
    const a = monteCarlo({ ...base, seed: 7 });
    expect(monteCarlo({ ...base, seed: 7 })).toEqual(a);
    expect(monteCarlo({ ...base, seed: 8 })).not.toEqual(a);
    expect(a).toMatchObject({ runs: 500, seed: 7, roundTrips: 3, ruinLevel: '80' });
    const finals = Object.values(a.finalEquity).map(Number);
    expect(finals).toEqual([...finals].sort((x, y) => x - y));
    // Three trips of +8, -20 and +15 from 100: the worst path ends at 40, the best at 145.
    expect(finals[0]).toBeGreaterThanOrEqual(40);
    expect(finals.at(-1)).toBeLessThanOrEqual(145);
    expect(Number(a.ruinProbabilityPercent)).toBeGreaterThan(0);
    expect(Number(a.ruinProbabilityPercent)).toBeLessThan(100);
  });

  it('with the ruin level blank, ruin is not set and the rest is returned', () => {
    const r = monteCarlo({ ...base, ruinLevel: null, seed: 1 });
    expect(r.ruinProbabilityPercent).toBeNull();
    expect(r.maxDrawdownPercent.p50).toMatch(/^\d/);
  });

  it('too few closed trips refuses by name', () => {
    expect(() => monteCarlo({ ...base, minTrades: 4, seed: 1 })).toThrow(/^quant\.montecarlo_trades_insufficient — /);
  });
});
