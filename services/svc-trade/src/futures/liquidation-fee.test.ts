import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import {
  LIQUIDATION_FEE_FRACTION_INVALID,
  LIQUIDATION_FEE_LEDGER_JOB_PENDING,
  LIQUIDATION_FEE_UNSET,
  LIQUIDATION_FEE_FRACTION_ENV,
  liquidationFeeKey,
  loadLiquidationFeeFraction,
  parseLiquidationFeeFraction,
  planLiquidationFee,
  presentLiquidationFeePlan,
} from './liquidation-fee.js';

// TEST figures only: these are not owner values.
const TEST_FRACTION = parseAmount('0.005');
const a = (s: string) => parseAmount(s);

describe('liquidation fee (D-margin-07)', () => {
  it('blank fraction → fee_unset, zero charged, no key', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const parsed = parseLiquidationFeeFraction(raw);
      expect(parsed).toEqual({ ok: true, fraction: null });
    }
    const plan = planLiquidationFee({ rungId: 'r1', fraction: null, notionalClosed: a('1000'), leftoverCollateral: a('50') });
    expect(plan).toEqual({ state: LIQUIDATION_FEE_UNSET, fee: 0n, key: null });
    expect(presentLiquidationFeePlan(plan)).toMatchObject({ fee: '0', feeState: 'fee_unset', charged: false, chargeReason: 'fee_unset' });
  });

  it('malformed or out-of-range fraction refuses typed, never clamped', () => {
    for (const raw of ['abc', '-0.1', '1.5', '0.1.2', '1e-3']) {
      expect(parseLiquidationFeeFraction(raw), raw).toMatchObject({ ok: false, code: LIQUIDATION_FEE_FRACTION_INVALID });
    }
    expect(parseLiquidationFeeFraction('0.0000000000000000001')).toMatchObject({ ok: false, code: LIQUIDATION_FEE_FRACTION_INVALID });
    expect(parseLiquidationFeeFraction('1')).toEqual({ ok: true, fraction: a('1') });
    expect(parseLiquidationFeeFraction('0')).toEqual({ ok: true, fraction: 0n });
  });

  it('leftover above fee → fee = fraction x notional (TEST), exact bigint', () => {
    const plan = planLiquidationFee({ rungId: 'r1', fraction: TEST_FRACTION, notionalClosed: a('1000'), leftoverCollateral: a('50') });
    expect(plan).toMatchObject({ state: 'planned', fee: a('5'), capped: false, key: 'r1:fee' });
    expect(presentLiquidationFeePlan(plan).fee).toBe('5');
  });

  it('leftover below fee → fee capped at leftover; equity never goes negative', () => {
    const plan = planLiquidationFee({ rungId: 'r2', fraction: TEST_FRACTION, notionalClosed: a('1000'), leftoverCollateral: a('2.5') });
    expect(plan).toMatchObject({ state: 'planned', fee: a('2.5'), capped: true });
  });

  it('no leftover or negative leftover → fee zero, never negative', () => {
    for (const leftover of [0n, a('-3')]) {
      const plan = planLiquidationFee({ rungId: 'r3', fraction: TEST_FRACTION, notionalClosed: a('1000'), leftoverCollateral: leftover });
      expect(plan.fee).toBe(0n);
    }
  });

  it('nothing is charged until ledger owner job J-3 lands', () => {
    const plan = planLiquidationFee({ rungId: 'r4', fraction: TEST_FRACTION, notionalClosed: a('10'), leftoverCollateral: a('10') });
    expect(plan.state === 'planned' && plan.chargeState).toBe(LIQUIDATION_FEE_LEDGER_JOB_PENDING);
    expect(presentLiquidationFeePlan(plan)).toMatchObject({ charged: false, chargeReason: LIQUIDATION_FEE_LEDGER_JOB_PENDING });
  });

  it('key is a business key bound to the rung: replay reuses it', () => {
    const input = { rungId: 'rung-7', fraction: TEST_FRACTION, notionalClosed: a('100'), leftoverCollateral: a('100') };
    expect(planLiquidationFee(input)).toEqual(planLiquidationFee(input));
    expect(liquidationFeeKey('rung-7')).toBe('rung-7:fee');
    expect(() => liquidationFeeKey(' ')).toThrow();
  });

  it('negative notional is rejected', () => {
    expect(() => planLiquidationFee({ rungId: 'r', fraction: TEST_FRACTION, notionalClosed: -1n, leftoverCollateral: 0n })).toThrow();
  });

  it('fraction below one ulp of notional rounds the fee down, never up', () => {
    const plan = planLiquidationFee({ rungId: 'r', fraction: 1n, notionalClosed: 1n, leftoverCollateral: a('1') });
    expect(plan.fee).toBe(0n);
  });
});

describe('loadLiquidationFeeFraction (boot config)', () => {
  it('unset or blank → null (fee unset)', () => {
    expect(loadLiquidationFeeFraction({})).toBeNull();
    expect(loadLiquidationFeeFraction({ [LIQUIDATION_FEE_FRACTION_ENV]: '  ' })).toBeNull();
  });

  it('valid TEST value parses to the scaled fraction; boundaries 0 and 1 accepted', () => {
    expect(loadLiquidationFeeFraction({ [LIQUIDATION_FEE_FRACTION_ENV]: '0.005' })).toBe(parseAmount('0.005'));
    expect(loadLiquidationFeeFraction({ [LIQUIDATION_FEE_FRACTION_ENV]: '0' })).toBe(0n);
    expect(loadLiquidationFeeFraction({ [LIQUIDATION_FEE_FRACTION_ENV]: '1' })).toBe(parseAmount('1'));
  });

  it('invalid config fails boot with the typed code, never read as no fee', () => {
    for (const raw of ['abc', '-0.1', '1.000000000000000001', '0.5%']) {
      expect(() => loadLiquidationFeeFraction({ [LIQUIDATION_FEE_FRACTION_ENV]: raw }), raw).toThrow(LIQUIDATION_FEE_FRACTION_INVALID);
    }
  });
});
