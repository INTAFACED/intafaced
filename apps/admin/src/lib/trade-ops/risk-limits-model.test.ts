import { describe, expect, it } from 'vitest';
import type { MarketRow } from './reads';
import { checkLimitEdit, decimalGte, isMultipleOf, isPositiveDecimal, limitEditOutcome } from './risk-limits-model';

const ME = 'me';
const market: MarketRow = {
  id: 'm1',
  symbol: 'BTC/USDT',
  base: 'BTC',
  quote: 'USDT',
  kind: 'spot',
  status: 'active',
  tickSize: '0.01',
  lotSize: '0.001',
  minQty: '0.001',
  maxQty: '100',
  minNotional: '5',
  makerBps: 10,
  takerBps: 20,
  listedAt: null,
};
const edit = (o: Record<string, unknown>) => ({
  symbol: 'BTC/USDT',
  field: 'minQty',
  value: '0.002',
  reason: 'tighten for incident',
  secondApproverId: 'you',
  ...o,
});

describe('decimal helpers', () => {
  it('multiples are exact', () => {
    expect(isMultipleOf('0.003', '0.001')).toBe(true);
    expect(isMultipleOf('0.0035', '0.001')).toBe(false);
    expect(isMultipleOf('0.3', '0.1')).toBe(true);
  });
  it('positive decimal', () => {
    expect(isPositiveDecimal('0.01')).toBe(true);
    expect(isPositiveDecimal('0')).toBe(false);
    expect(isPositiveDecimal('1e3')).toBe(false);
    expect(isPositiveDecimal('-1')).toBe(false);
  });
  it('compare', () => {
    expect(decimalGte('10', '9.99')).toBe(true);
    expect(decimalGte('0.1', '0.10')).toBe(true);
  });
});

describe('checkLimitEdit', () => {
  it('accepts a valid min quantity', () => expect(checkLimitEdit(edit({}), [market], ME).ok).toBe(true));
  it('refuses a quantity off the lot grid', () =>
    expect(checkLimitEdit(edit({ value: '0.0025' }), [market], ME)).toMatchObject({ code: 'risk_limits.not_lot_multiple' }));
  it('refuses min above max', () =>
    expect(checkLimitEdit(edit({ value: '200' }), [market], ME)).toMatchObject({ code: 'risk_limits.min_above_max' }));
  it('refuses a lot size that breaks min quantity', () =>
    expect(checkLimitEdit(edit({ field: 'lotSize', value: '0.0025' }), [market], ME)).toMatchObject({
      code: 'risk_limits.not_lot_multiple',
    }));
  it('refuses unchanged, garbage, and unknown market', () => {
    expect(checkLimitEdit(edit({ value: '0.001' }), [market], ME)).toMatchObject({ code: 'risk_limits.no_change' });
    expect(checkLimitEdit(edit({ field: 'tickSize', value: 'abc' }), [market], ME)).toMatchObject({ code: 'risk_limits.bad_value' });
    expect(checkLimitEdit(edit({ symbol: 'NOPE/USDT' }), [market], ME)).toMatchObject({ code: 'risk_limits.unknown_market' });
  });
  it('bps are whole numbers', () => {
    expect(checkLimitEdit(edit({ field: 'takerBps', value: '12.5' }), [market], ME)).toMatchObject({ code: 'risk_limits.bad_value' });
    expect(checkLimitEdit(edit({ field: 'takerBps', value: '25' }), [market], ME).ok).toBe(true);
  });
  it('needs a different second approver and a reason', () => {
    expect(checkLimitEdit(edit({ secondApproverId: ME }), [market], ME)).toMatchObject({ code: 'missing_operator' });
    expect(checkLimitEdit(edit({ reason: 'short' }), [market], ME)).toMatchObject({ code: 'risk_limits.bad_reason' });
  });
  it('a valid edit ends in the typed blocker', () => {
    expect(limitEditOutcome(edit({}), [market], ME)).toMatchObject({ kind: 'refused', blocker: { key: 'risk_limits_no_operator_api' } });
  });
});
