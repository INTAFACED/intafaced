import { describe, expect, it } from 'vitest';
import { blankReasons } from './AccountMetrics';
import type { MarginSummary } from './api';

const base: MarginSummary = {
  positions: 1,
  asset: 'USDT',
  available: '10',
  usedMargin: '5',
  totalInitialMargin: '5',
  totalMaintenanceMargin: '1',
  equity: '6',
  excess: '5',
  deficit: '0',
  marginRatio: '0.166666666666666666',
  buyingPower: null,
  missing: [{ field: 'TRADE_COLLATERAL_HAIRCUT_BPS', code: 'haircut_unset' }],
};

describe('blankReasons', () => {
  it('names nothing when every figure the panel shows is there (the haircut is not one of them)', () => {
    expect(blankReasons(base)).toEqual({ mixed: false, equityNotPositive: false, inputs: [] });
  });

  it('names positions in more than one margin asset', () => {
    const r = blankReasons({ ...base, asset: null, missing: [{ field: 'asset', code: 'margin_assets_mixed' }] });
    expect(r.mixed).toBe(true);
  });

  it('names equity at or below zero', () => {
    const r = blankReasons({ ...base, equity: '-1', marginRatio: null, missing: [{ field: 'marginRatio', code: 'equity_not_positive' }] });
    expect(r).toEqual({ mixed: false, equityNotPositive: true, inputs: [] });
  });

  it('names each missing input once, and an unknown one as other', () => {
    const r = blankReasons({
      ...base,
      missing: [
        { field: 'maintenanceMargin', code: 'missing_input' },
        { field: 'collateral', code: 'missing_input' },
        { field: 'maintenanceMargin', code: 'missing_input' },
        { field: 'somethingNew', code: 'missing_input' },
      ],
    });
    expect(r.inputs).toEqual(['maintenanceMargin', 'collateral', 'other']);
  });
});
