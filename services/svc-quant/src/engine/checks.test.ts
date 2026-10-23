import { describe, expect, it } from 'vitest';
import type { QuantBacktestResult, QuantCheckThresholds, QuantSampleSection } from '@intafaced/contracts';
import { checksOf } from './checks.js';

const UNSET: QuantCheckThresholds = { maxSampleGapPercent: null, maxVariants: null, maxOffsetShiftPercent: null };
const SET: QuantCheckThresholds = { maxSampleGapPercent: '5', maxVariants: '3', maxOffsetShiftPercent: '1' };

function result(patch: Partial<Pick<QuantBacktestResult, 'variantCount' | 'offsetRun'>> = {}) {
  return {
    totals: { startCash: '1000', gross: '0', fees: '0', slippage: '0', net: '20', endEquity: '1020', openQty: '0' },
    variantCount: 4,
    offsetRun: { from: '2026-10-20T01:00:00.000Z', returnPercent: { value: '0.5', reason: null }, trades: 2 },
    coverage: { barSize: '1h' as const, bars: 8, expected: 8, first: null, last: null, gaps: [], fraction: '1' },
    ...patch,
  };
}

function part(returnPercent: string | null): QuantSampleSection {
  return {
    from: '',
    to: '',
    startEquity: '1000',
    endEquity: '1000',
    returnPercent: { value: returnPercent, reason: returnPercent === null ? 'zero_base' : null },
    maxDrawdownPercent: { value: '0', reason: null },
    roundTrips: 1,
  };
}

const byName = (checks: ReturnType<typeof checksOf>) => Object.fromEntries(checks.map((check) => [check.name, check]));

describe('checks on a result (AL-backtest-04, ENGINE BT-9)', () => {
  it('lists all six, every time, in one order', () => {
    expect(checksOf(result(), null, UNSET).map((check) => check.name)).toEqual([
      'sample_gap',
      'variant_count',
      'bar_offset',
      'bar_type',
      'look_ahead',
      'repainting',
    ]);
  });

  it('warns above a threshold with its evidence, and is clear at or under it', () => {
    const checks = byName(checksOf(result(), { inSample: part('8'), outOfSample: part('2') }, SET));
    expect(checks.sample_gap).toEqual({
      name: 'sample_gap',
      status: 'warning',
      threshold: '5',
      evidence: { inSampleReturnPercent: '8', outOfSampleReturnPercent: '2', gapPercent: '6' },
    });
    expect(checks.variant_count).toMatchObject({ status: 'warning', evidence: { variants: '4' } });
    // The whole run returned 2 %; from one bar later 0.5 %: a move of 1.5 points.
    expect(checks.bar_offset).toMatchObject({
      status: 'warning',
      evidence: { returnPercent: '2', offsetReturnPercent: '0.5', shiftPercent: '1.5' },
    });
    const calm = byName(
      checksOf(
        result({
          variantCount: 3,
          offsetRun: { from: '2026-10-20T01:00:00.000Z', trades: 2, returnPercent: { value: '3', reason: null } },
        }),
        { inSample: part('7'), outOfSample: part('2') },
        SET,
      ),
    );
    expect(calm.sample_gap!.status).toBe('clear');
    expect(calm.variant_count!.status).toBe('clear');
    expect(calm.bar_offset).toMatchObject({ status: 'clear', evidence: { shiftPercent: '1' } });
  });

  it('reads "not set" and warns of nothing while a threshold is blank, and says why a check cannot be made', () => {
    const blank = byName(checksOf(result(), { inSample: part('80'), outOfSample: part('-50') }, UNSET));
    for (const name of ['sample_gap', 'variant_count', 'bar_offset'])
      expect(blank[name]).toMatchObject({ status: 'not_set', threshold: null });
    expect(blank.sample_gap!.evidence.gapPercent).toBe('130');

    const missing = byName(checksOf(result({ variantCount: null, offsetRun: null }), null, SET));
    expect(missing.sample_gap).toMatchObject({ status: 'not_applicable', evidence: { reason: 'not_split' } });
    expect(missing.variant_count).toMatchObject({ status: 'not_applicable', evidence: { reason: 'not_counted' } });
    expect(missing.bar_offset).toMatchObject({ status: 'not_applicable', evidence: { reason: 'too_few_bars' } });
    expect(byName(checksOf({ ...result(), offsetRun: undefined }, null, SET)).bar_offset).toMatchObject({
      status: 'not_applicable',
      evidence: { reason: 'not_run' },
    });
    const undefinedPart = byName(checksOf(result(), { inSample: part(null), outOfSample: part('1') }, SET));
    expect(undefinedPart.sample_gap).toMatchObject({ status: 'not_applicable', evidence: { reason: 'section_undefined' } });
  });

  it('names time bars and rules out look-ahead and repainting by how the engine is built', () => {
    const checks = byName(checksOf(result(), null, SET));
    expect(checks.bar_type).toEqual({ name: 'bar_type', status: 'clear', threshold: null, evidence: { barSize: '1h', kind: 'time' } });
    expect(checks.look_ahead).toMatchObject({ status: 'by_construction', evidence: { rule: 'closed_bars_only' } });
    expect(checks.repainting).toMatchObject({ status: 'by_construction', evidence: { rule: 'stored_run_immutable' } });
  });
});
