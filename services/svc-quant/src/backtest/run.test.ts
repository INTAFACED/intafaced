import { describe, expect, it } from 'vitest';
import {
  QUANT_BACKTEST_FILLS_MISSING,
  QUANT_BACKTEST_LAKE_MISSING,
  QUANT_BACKTEST_SURFACE_REFUSED,
  QUANT_BACKTEST_WALK_FORWARD_REQUIRED,
  QUANT_ENVIRONMENT_REQUIRED,
  QUANT_SIMULATED_AS_LIVE,
  QuantError,
} from '../errors.js';
import type { BacktestLake, LakeFill } from './lake.js';
import { runBacktest } from './run.js';

const walkForward = {
  inSampleFrom: '2026-01-01T00:00:00.000Z',
  inSampleTo: '2026-04-01T00:00:00.000Z',
  outOfSampleFrom: '2026-04-01T00:00:00.000Z',
  outOfSampleTo: '2026-07-01T00:00:00.000Z',
};

const costModel = {
  fees: { kind: 'venue-schedule' as const, source: 'connect:venue-a:fee-schedule:v7' },
  slippage: { kind: 'order-book-replay' as const, source: 'connect:data-lake:venue-a:depth:v3' },
  latency: { kind: 'measured-distribution' as const, source: 'connect:venue-a:round-trip:2026-q2' },
};

const fills: LakeFill[] = [
  { ts: '2026-02-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.01', price: '50000' },
  { ts: '2026-05-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.02', price: '51000' },
];

function lakeWith(rows: readonly LakeFill[] | null, wired = true): BacktestLake {
  return { wired, fills: () => rows };
}

const honest = {
  strategyId: 'alpha',
  symbol: 'BTC-USD',
  environment: 'backtest' as const,
  costModel,
  strategyVariantCount: 1,
  strategyVersion: 1,
};

describe('backtest.run — event-level, walk-forward, lake fills', () => {
  it('refuses missing environment instead of defaulting to live', () => {
    expect(() =>
      runBacktest(
        { strategyId: 'alpha', symbol: 'BTC-USD', walkForward, outOfSampleStatus: 'passed', costModel, strategyVariantCount: 1 },
        lakeWith(fills),
      ),
    ).toThrow(QUANT_ENVIRONMENT_REQUIRED);
  });

  it('refuses live environment on the backtest surface', () => {
    expect(() => runBacktest({ ...honest, walkForward, outOfSampleStatus: 'passed', environment: 'live' }, lakeWith(fills))).toThrow(
      QUANT_SIMULATED_AS_LIVE,
    );
  });

  it('refuses missing walk-forward by name', () => {
    expect(() => runBacktest({ ...honest, outOfSampleStatus: 'passed' }, lakeWith(fills))).toThrow(QUANT_BACKTEST_WALK_FORWARD_REQUIRED);
  });

  it('refuses missing lake by name and does not invent candles', () => {
    expect(() => runBacktest({ ...honest, walkForward, outOfSampleStatus: 'passed' }, lakeWith(null, false))).toThrow(
      QUANT_BACKTEST_LAKE_MISSING,
    );
    expect(() => runBacktest({ ...honest, walkForward, outOfSampleStatus: 'passed' }, lakeWith(null, true))).toThrow(
      QUANT_BACKTEST_LAKE_MISSING,
    );
  });

  it('refuses missing fills by name and does not invent candles', () => {
    expect(() => runBacktest({ ...honest, walkForward, outOfSampleStatus: 'passed' }, lakeWith([]))).toThrow(QUANT_BACKTEST_FILLS_MISSING);
  });

  it('does not weaken OOS / cost-model refusals from assessBacktestSurface', () => {
    expect(() => runBacktest({ ...honest, walkForward }, lakeWith(fills))).toThrow(/missing_out_of_sample_verdict/);
    expect(() => runBacktest({ ...honest, walkForward, outOfSampleStatus: 'passed', costModel: undefined }, lakeWith(fills))).toThrow(
      /missing_fee_model/,
    );
    try {
      runBacktest({ ...honest, walkForward }, lakeWith(fills));
    } catch (err) {
      expect((err as Error).message).toContain(QUANT_BACKTEST_SURFACE_REFUSED);
    }
  });

  it('metrics come from lake fills as decimal strings — no invented return', () => {
    const ran = runBacktest({ ...honest, walkForward, outOfSampleStatus: 'passed' }, lakeWith(fills));
    expect(ran.ok).toBe(true);
    expect(ran.inSample.fillCount).toBe(1);
    expect(ran.inSample.notional).toBe('500');
    expect(typeof ran.inSample.notional).toBe('string');
    expect(ran.outOfSample.fillCount).toBe(1);
    expect(ran.outOfSample.notional).toBe('1020');
    expect('pnl' in ran).toBe(false);
    expect('return' in ran).toBe(false);
    expect(ran.claimLabel).toBe('Historical simulation — not a forecast');
    expect(ran.environment).toBe('backtest');
    expect(ran.live).toBe(false);
    expect(ran.simulated).toBe(true);
    expect(ran.kind).toBe('simulated');
  });

  it('refuses a negative qty or price and does not count that fill', () => {
    const refuse = (rows: readonly LakeFill[]) => {
      expect(() => runBacktest({ ...honest, walkForward, outOfSampleStatus: 'passed' }, lakeWith(rows))).toThrow(QuantError);
      try {
        runBacktest({ ...honest, walkForward, outOfSampleStatus: 'passed' }, lakeWith(rows));
        expect.fail('runBacktest returned ok');
      } catch (err) {
        expect(err).toBeInstanceOf(QuantError);
        expect((err as QuantError).code).toBe('quant.params_invalid');
        expect((err as Error).message).toMatch(/negative fill/);
        expect((err as Error).message).toMatch(/not invented/);
      }
    };

    refuse([{ ts: '2026-02-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '-0.01', price: '50000' }]);
    refuse([{ ts: '2026-05-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.02', price: '-51000' }]);
    refuse([{ ts: '2026-05-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '-0.02', price: '-51000' }]);
    refuse([
      { ts: '2026-02-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.01', price: '50000' },
      { ts: '2026-05-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '-0.02', price: '51000' },
    ]);
  });

  it('refuses a blank fill timestamp instead of dropping it', () => {
    const refuse = (ts: string) => {
      const rows: LakeFill[] = [
        { ts, symbol: 'BTC-USD', qty: '0.01', price: '50000' },
        { ts: '2026-05-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.02', price: '51000' },
      ];
      try {
        runBacktest({ ...honest, walkForward, outOfSampleStatus: 'passed' }, lakeWith(rows));
        expect.fail('runBacktest returned ok');
      } catch (err) {
        expect(err).toBeInstanceOf(QuantError);
        expect((err as QuantError).code).toBe('quant.params_invalid');
        expect((err as Error).message).toMatch(/fill timestamp is refused/);
        expect((err as Error).message).toMatch(/not invented/);
      }
    };

    refuse('');
    refuse('   ');
    refuse('not-a-date');
    refuse('2026-13-01T00:00:00.000Z');
  });

  it('refuses a zone-less fill timestamp and does not follow a local-time reading', () => {
    const insideLocal = '2026-02-15T12:00:00';
    const asUtcDate = '2026-02-15';
    const outsideLocal = '1990-01-01T00:00:00';
    const local = Date.parse(insideLocal);
    expect(Number.isFinite(local)).toBe(true);
    expect(local).toBeGreaterThanOrEqual(Date.parse(walkForward.inSampleFrom));
    expect(local).toBeLessThan(Date.parse(walkForward.inSampleTo));
    expect(Date.parse(asUtcDate)).toBe(Date.parse('2026-02-15T00:00:00.000Z'));

    for (const ts of [insideLocal, asUtcDate, outsideLocal]) {
      const rows: LakeFill[] = [
        { ts, symbol: 'BTC-USD', qty: '0.01', price: '50000' },
        { ts: '2026-05-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.02', price: '51000' },
      ];
      try {
        runBacktest({ ...honest, walkForward, outOfSampleStatus: 'passed' }, lakeWith(rows));
        expect.fail('runBacktest returned ok');
      } catch (err) {
        expect(err).toBeInstanceOf(QuantError);
        expect((err as QuantError).code).toBe('quant.params_invalid');
        expect((err as Error).message).toMatch(/fill timestamp is refused/);
        expect((err as Error).message).toMatch(/not invented/);
      }
    }
  });

  it('counts a fill with Z or an explicit offset', () => {
    const rows: LakeFill[] = [
      { ts: '2026-02-01T05:00:00+05:00', symbol: 'BTC-USD', qty: '0.01', price: '50000' },
      { ts: '2026-03-01T00:00:00+0000', symbol: 'BTC-USD', qty: '0.01', price: '10000' },
      { ts: '2026-05-01T00:00:00.000Z', symbol: 'BTC-USD', qty: '0.02', price: '51000' },
    ];
    const ran = runBacktest({ ...honest, walkForward, outOfSampleStatus: 'passed' }, lakeWith(rows));
    expect(ran.ok).toBe(true);
    expect(ran.inSample.fillCount).toBe(2);
    expect(ran.inSample.notional).toBe('600');
    expect(ran.outOfSample.fillCount).toBe(1);
    expect(ran.outOfSample.notional).toBe('1020');
  });

  it('refuses a zone-less walk-forward bound instead of reading local time', () => {
    const zoneLessFrom = '2026-01-01T00:00:00';
    expect(Number.isFinite(Date.parse(zoneLessFrom))).toBe(true);
    expect(() =>
      runBacktest(
        {
          ...honest,
          walkForward: { ...walkForward, inSampleFrom: zoneLessFrom },
          outOfSampleStatus: 'passed',
        },
        lakeWith(fills),
      ),
    ).toThrow(QUANT_BACKTEST_WALK_FORWARD_REQUIRED);
  });
});
