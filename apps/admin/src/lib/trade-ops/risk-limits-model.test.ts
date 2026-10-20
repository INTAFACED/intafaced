import { describe, expect, it } from 'vitest';
import type { MarketRow } from './reads';
import { checkLimitEdit, checkRiskSet, decimalGte, isMultipleOf, isPositiveDecimal, limitEditOutcome } from './risk-limits-model';

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
    expect(limitEditOutcome(edit({}), [market], ME)).toMatchObject({ kind: 'refused', blocker: { key: 'market_rules_no_operator_api' } });
  });
});

describe('checkRiskSet', () => {
  const now = { marketId: 'm1', version: '3', collar: '0.05', fatFinger: null, slippageCap: null, throttle: null, circuitBreaker: null };
  const vals = { collar: '0.05', fatFinger: '', slippageCap: '', throttle: '', circuitBreaker: '' };
  const REASON = 'tighten after incident 4471';
  it('builds the write for the version it was given, with a blank as unset', () => {
    expect(checkRiskSet(now, { ...vals, fatFinger: '1000.5', slippageCap: '100' }, REASON)).toEqual({
      ok: true,
      body: {
        market: 'm1',
        expectedVersion: '3',
        reason: REASON,
        limits: { collar: '0.05', fatFinger: '1000.5', slippageCap: '100', throttle: null, circuitBreaker: null },
      },
    });
  });
  it('can clear a limit back to unset', () => {
    const out = checkRiskSet(now, { ...vals, collar: '' }, REASON);
    expect(out).toMatchObject({ ok: true, body: { limits: { collar: null } } });
  });
  it('refuses no change, bad values, slippage outside 1 to 5000 and a short reason', () => {
    expect(checkRiskSet(now, vals, REASON)).toMatchObject({ code: 'risk_limits.no_change' });
    for (const bad of ['1e3', '-1', '1.5.2', '0x10', ' 1 2'])
      expect(checkRiskSet(now, { ...vals, throttle: bad }, REASON)).toMatchObject({ code: 'risk_limits.bad_value' });
    expect(checkRiskSet(now, { ...vals, collar: '0.1234567890123456789' }, REASON)).toMatchObject({ code: 'risk_limits.bad_value' });
    expect(checkRiskSet(now, { ...vals, slippageCap: '0' }, REASON)).toMatchObject({ code: 'risk_limits.bad_value' });
    expect(checkRiskSet(now, { ...vals, slippageCap: '5001' }, REASON)).toMatchObject({ code: 'risk_limits.bad_value' });
    expect(checkRiskSet(now, { ...vals, throttle: '5' }, 'short')).toMatchObject({ code: 'risk_limits.bad_reason' });
    expect(checkRiskSet(now, { ...vals, throttle: '5' }, undefined)).toMatchObject({ code: 'risk_limits.bad_reason' });
  });
});
