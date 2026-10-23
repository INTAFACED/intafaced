import { describe, expect, it } from 'vitest';
import { quantOutOfSampleFrom, type QuantBacktestResult, type QuantVerdictCriteria } from '@intafaced/contracts';
import { holdoutStartMs } from './run.js';
import { sectionsOf, verdictOf } from './verdict.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-20T00:00:00.000Z');
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString();

function trade(hours: number, side: 'buy' | 'sell', price: string): QuantBacktestResult['trades'][number] {
  return { ts: at(hours), side, reason: 'signal', qty: '1', barPrice: price, price, fee: '0', slippage: '0' };
}

/** Six hourly points; the split at hour 4 leaves 0-3 in sample and 4-5 out of sample. */
function run(equity: readonly string[], trades: QuantBacktestResult['trades']) {
  return {
    trades,
    equity: equity.map((value, i) => ({ ts: at(i), equity: value })),
    totals: { startCash: '1000', gross: '0', fees: '0', slippage: '0', net: '0', endEquity: '0', openQty: '0' },
    window: { from: at(0), to: at(equity.length) },
  };
}

const SET: QuantVerdictCriteria = { minTrades: '1', minReturnPercent: '0', maxDrawdownPercent: '5', maxShortfallPercent: '3' };

describe('out-of-sample split (ENGINE BT-9)', () => {
  it('takes the latest half, third or quarter, moved up to the next bar open, or a chosen start', () => {
    const window = { fromMs: T0, toMs: T0 + 9 * HOUR };
    expect(quantOutOfSampleFrom(window, '1/3', HOUR)).toBe(T0 + 6 * HOUR);
    // 9 / 2 = 4.5 hours back from the end is 04:30; the part starts at the next bar open, 05:00.
    expect(quantOutOfSampleFrom(window, '1/2', HOUR)).toBe(T0 + 5 * HOUR);
    expect(quantOutOfSampleFrom(window, '1/4', HOUR)).toBe(T0 + 7 * HOUR);
    expect(quantOutOfSampleFrom(window, 'custom', HOUR, T0 + 2 * HOUR + 1)).toBe(T0 + 3 * HOUR);
    // Either part without a whole bar is no split.
    expect(quantOutOfSampleFrom({ fromMs: T0, toMs: T0 + HOUR }, '1/2', HOUR)).toBeNull();
    expect(quantOutOfSampleFrom(window, 'custom', HOUR, T0 + 9 * HOUR)).toBeNull();
    expect(quantOutOfSampleFrom(window, 'custom', HOUR)).toBeNull();
  });
});

describe('sections and the computed verdict (ENGINE MT-7, T-8)', () => {
  it('splits equity by bar and round trips by entry, each part with its own return and drawdown', () => {
    const trades = [trade(0, 'buy', '100'), trade(2, 'sell', '110'), trade(3, 'buy', '100'), trade(5, 'sell', '104')];
    const sections = sectionsOf(run(['1000', '1010', '1010', '1010', '1012', '1014'], trades), at(4));
    // In sample: 1000 to 1010, 1%. Out of sample: from 1010 to 1014, 0.396%. The trip entered at 3 counts in sample.
    expect(sections.inSample).toMatchObject({ startEquity: '1000', endEquity: '1010', roundTrips: 2 });
    expect(sections.inSample.returnPercent).toEqual({ value: '1', reason: null });
    expect(sections.outOfSample).toMatchObject({ from: at(4), to: at(6), startEquity: '1010', endEquity: '1014', roundTrips: 0 });
    expect(sections.outOfSample.returnPercent).toEqual({ value: '0.396', reason: null });
  });

  it('passes when the out-of-sample part meets every criterion, and fails naming each one it misses', () => {
    const trades = [trade(0, 'buy', '100'), trade(1, 'sell', '101'), trade(4, 'buy', '100'), trade(5, 'sell', '102')];
    const good = sectionsOf(run(['1000', '1005', '1005', '1005', '1006', '1008'], trades), at(4));
    expect(verdictOf(good, SET)).toEqual({ status: 'passed', reasons: [], unset: [], criteria: SET });

    // Out of sample loses money after costs and falls 4% from its start: below the minimum return and short of in sample.
    const losing = sectionsOf(run(['1000', '1010', '1010', '1010', '980', '970'], trades), at(4));
    expect(verdictOf(losing, SET)).toMatchObject({ status: 'failed', reasons: ['return_below_minimum', 'shortfall_above_maximum'] });
    expect(verdictOf(losing, { ...SET, maxDrawdownPercent: '1' }).reasons).toContain('drawdown_above_maximum');
  });

  it('reads inconclusive, never passed, when a criterion is blank, when too few trades closed, or when the run was not split', () => {
    const trades = [trade(0, 'buy', '100'), trade(1, 'sell', '101'), trade(4, 'buy', '100'), trade(5, 'sell', '102')];
    const good = sectionsOf(run(['1000', '1005', '1005', '1005', '1006', '1008'], trades), at(4));
    expect(verdictOf(good, { ...SET, maxShortfallPercent: null })).toEqual({
      status: 'inconclusive',
      reasons: ['criteria_unset'],
      unset: ['maxShortfallPercent'],
      criteria: { ...SET, maxShortfallPercent: null },
    });
    expect(verdictOf(good, { ...SET, minTrades: '2' })).toMatchObject({ status: 'inconclusive', reasons: ['too_few_trades'] });
    expect(verdictOf(null, SET)).toMatchObject({ status: 'inconclusive', reasons: ['not_split'] });
  });

  it('flips with the out-of-sample data alone', () => {
    const trades = [trade(0, 'buy', '100'), trade(1, 'sell', '101'), trade(4, 'buy', '100'), trade(5, 'sell', '102')];
    const up = verdictOf(sectionsOf(run(['1000', '1005', '1005', '1005', '1006', '1008'], trades), at(4)), SET);
    const down = verdictOf(sectionsOf(run(['1000', '1005', '1005', '1005', '1000', '990'], trades), at(4)), SET);
    expect([up.status, down.status]).toEqual(['passed', 'failed']);
  });
});

describe('owner holdout', () => {
  it('reads a fixed instant or a span back from the request, and nothing from a blank or empty value', () => {
    const now = T0 + 10 * HOUR;
    expect(holdoutStartMs('2026-10-20T06:00:00+02:00', now)).toBe(T0 + 4 * HOUR);
    expect(holdoutStartMs('PT6H', now)).toBe(T0 + 4 * HOUR);
    expect(holdoutStartMs('P1DT2H', now)).toBe(now - 26 * HOUR);
    expect(holdoutStartMs('P', now)).toBeNull();
    expect(holdoutStartMs(null, now)).toBeNull();
  });
});
