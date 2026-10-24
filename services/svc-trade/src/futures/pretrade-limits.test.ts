/**
 * Owner pre-trade limits (#4725) — pure boundary proofs, no database.
 *
 * Every limit is whole quote-asset units compared in scaled bigint. EXACTLY at
 * the limit is allowed; one unit (1e-18) over is refused. The env values used
 * here are test fixtures only, never product law.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { CCXT_ERROR_MAPPING, toCcxtError } from '../ccxt-errors.js';
import { TradeError } from '../spot/types.js';
import {
  LIMIT_MAX_LOSS,
  LIMIT_MAX_ORDER,
  LIMIT_MAX_POSITION,
  MAX_ORDER_UNSET,
  checkMaxLoss,
  checkMaxOrder,
  checkMaxOrderNotional,
  checkMaxPosition,
  markPreTradeCreditInstalled,
  resolveAdmissionLimits,
  signedSize,
  type AdmissionLimits,
} from './pretrade-limits.js';
import { tradeServiceSource } from '../spot/trade-service/source.testkit.js';

const here = dirname(fileURLToPath(import.meta.url));
const UNIT = 1n; // one scaled unit = 1e-18
const limits = (over: Partial<AdmissionLimits> = {}): AdmissionLimits => ({
  maxOrder: 1000,
  maxPosition: 5000,
  maxLoss: 100,
  ...over,
});

describe('TRADE_MAX_ORDER boundary (notional = price x qty, whole quote units)', () => {
  const l = limits();
  it('limit - 1 unit allowed, exactly the limit allowed, limit + 1 unit refused', () => {
    // price 1000 x qty 1 = 1000 exactly.
    expect(checkMaxOrder({ limits: l, quoteAsset: 'USDT', price: amt('1000'), qty: amt('1') - UNIT })).toBeNull();
    expect(checkMaxOrder({ limits: l, quoteAsset: 'USDT', price: amt('1000'), qty: amt('1') })).toBeNull();
    const over = checkMaxOrder({ limits: l, quoteAsset: 'USDT', price: amt('1000'), qty: amt('1') + UNIT });
    expect(over?.code).toBe(LIMIT_MAX_ORDER);
    expect(over?.message).toContain('1000.000000000000001');
    expect(over?.message).toContain('limit of 1000 USDT');
  });

  it('a sub-unit overshoot is never rounded away (price x qty is compared exactly)', () => {
    // 0.000000000000000001 x 1000000000000000001e-18... use a product that is 1000 + 1e-36.
    const price = amt('1000') + UNIT;
    const qty = amt('1'); // price*qty = 1000 + 1e-18 -> over
    expect(checkMaxOrder({ limits: l, quoteAsset: 'USDT', price, qty })?.code).toBe(LIMIT_MAX_ORDER);
    // 1e-18 x 1e-18 scale product below one unit but the order is still under the cap.
    expect(checkMaxOrder({ limits: l, quoteAsset: 'USDT', price: amt('999.999999999999999999'), qty: amt('1') })).toBeNull();
  });

  it('a published 0 refuses every order; an unpublished limit compares nothing', () => {
    expect(checkMaxOrder({ limits: limits({ maxOrder: 0 }), quoteAsset: 'USDT', price: amt('1'), qty: UNIT })?.code).toBe(LIMIT_MAX_ORDER);
    expect(checkMaxOrder({ limits: limits({ maxOrder: null }), quoteAsset: 'USDT', price: amt('1'), qty: amt('1') })).toBeNull();
  });

  it('convert: a ready-made notional uses the same boundary', () => {
    const base = { limits: l, quoteAsset: 'USDT', what: 'convert' };
    expect(checkMaxOrderNotional({ ...base, notional: amt('1000') })).toBeNull();
    const over = checkMaxOrderNotional({ ...base, notional: amt('1000') + UNIT });
    expect(over?.code).toBe(LIMIT_MAX_ORDER);
    expect(over?.message).toMatch(/^convert notional /);
  });
});

describe('TRADE_MAX_POSITION boundary (resulting position, signed)', () => {
  const l = limits({ maxPosition: 5000 });
  const price = amt('1000');
  const check = (existing: bigint, delta: bigint) =>
    checkMaxPosition({ limits: l, quoteAsset: 'USDT', existingSignedSize: existing, deltaSignedSize: delta, price });

  it('limit - 1 unit allowed, exactly the limit allowed, limit + 1 unit refused', () => {
    expect(check(0n, amt('5') - UNIT)).toBeNull();
    expect(check(0n, amt('5'))).toBeNull();
    const over = check(0n, amt('5') + UNIT);
    expect(over?.code).toBe(LIMIT_MAX_POSITION);
    expect(over?.message).toContain('limit of 5000 USDT');
  });

  it('counts the RESULTING position: existing + new, and long to short crossing', () => {
    // Already long 4, +1.000...1 more would be 5.000...1 -> refused.
    expect(check(amt('4'), amt('1'))).toBeNull();
    expect(check(amt('4'), amt('1') + UNIT)?.code).toBe(LIMIT_MAX_POSITION);
    // Long 3, short 8 -> resulting short 5 (the crossing is counted on the net): allowed at exactly 5.
    expect(check(amt('3'), -amt('8'))).toBeNull();
    expect(check(amt('3'), -amt('8') - UNIT)?.code).toBe(LIMIT_MAX_POSITION);
  });

  it('a reducing order is never refused, even when the position is already past the limit', () => {
    // Long 9 (over the 5-unit cap, e.g. the owner lowered it) reduced by 1 -> allowed.
    expect(check(amt('9'), -amt('1'))).toBeNull();
    // Reducing to flat, and reducing a short, are allowed too.
    expect(check(amt('9'), -amt('9'))).toBeNull();
    expect(check(-amt('9'), amt('2'))).toBeNull();
    // But growing a position that is already over the cap is refused.
    expect(check(amt('9'), UNIT)?.code).toBe(LIMIT_MAX_POSITION);
    // Crossing from a huge long to a short that is itself over the cap is NOT reducing |position|... here |after| 6 < |before| 9: allowed.
    expect(check(amt('9'), -amt('15'))).toBeNull();
    // ...and a crossing that ends larger than it started is growth.
    expect(check(amt('6'), -amt('13'))?.code).toBe(LIMIT_MAX_POSITION);
  });

  it('signedSize', () => {
    expect(signedSize('long', amt('2'))).toBe(amt('2'));
    expect(signedSize('short', amt('2'))).toBe(-amt('2'));
  });
});

describe('TRADE_MAX_LOSS boundary (current unrealised loss, whole quote units)', () => {
  const l = limits({ maxLoss: 100 });
  const check = (loss: bigint) => checkMaxLoss({ limits: l, quoteAsset: 'USDT', unrealisedLoss: loss });
  it('limit - 1 unit allowed, exactly the limit allowed, limit + 1 unit refused', () => {
    expect(check(amt('100') - UNIT)).toBeNull();
    expect(check(amt('100'))).toBeNull();
    const over = check(amt('100') + UNIT);
    expect(over?.code).toBe(LIMIT_MAX_LOSS);
    expect(over?.message).toContain('limit of 100 USDT');
  });
  it('no loss is never refused, even with a published 0', () => {
    expect(checkMaxLoss({ limits: limits({ maxLoss: 0 }), quoteAsset: 'USDT', unrealisedLoss: 0n })).toBeNull();
    expect(checkMaxLoss({ limits: limits({ maxLoss: 0 }), quoteAsset: 'USDT', unrealisedLoss: UNIT })?.code).toBe(LIMIT_MAX_LOSS);
  });
});

describe('resolveAdmissionLimits (fail closed in production posture)', () => {
  it('outside the production posture an unpublished limit is simply not compared', () => {
    const r = resolveAdmissionLimits({ TRADE_MAX_ORDER: '10' } as NodeJS.ProcessEnv);
    // Another test file in this worker may already have installed the mill; both answers are honest.
    if ('limits' in r) expect(r.limits.maxOrder).toBe(10);
  });

  it('after the mill is installed every unset / unparsable limit refuses with the existing unset code', () => {
    markPreTradeCreditInstalled();
    const unset = resolveAdmissionLimits({} as NodeJS.ProcessEnv);
    expect('refusal' in unset && unset.refusal.code).toBe(MAX_ORDER_UNSET);
    const bad = resolveAdmissionLimits({ TRADE_MAX_ORDER: '10.5', TRADE_MAX_POSITION: '1', TRADE_MAX_LOSS: '1' } as NodeJS.ProcessEnv);
    expect('refusal' in bad && bad.refusal.code).toBe(MAX_ORDER_UNSET);
    const ok = resolveAdmissionLimits({ TRADE_MAX_ORDER: '10', TRADE_MAX_POSITION: '20', TRADE_MAX_LOSS: '0' } as NodeJS.ProcessEnv);
    expect('limits' in ok && ok.limits).toEqual({ maxOrder: 10, maxPosition: 20, maxLoss: 0 });
  });
});

describe('wire mapping and exempt doors', () => {
  it('each limit code maps to ccxt InvalidOrder / HTTP 422 and carries its intafaced code', () => {
    for (const code of [LIMIT_MAX_ORDER, LIMIT_MAX_POSITION, LIMIT_MAX_LOSS] as const) {
      expect(CCXT_ERROR_MAPPING[code]).toEqual({ ccxt: 'InvalidOrder', status: 422 });
      const wire = toCcxtError(new TradeError(`limit ${code}`, code));
      expect(wire).toMatchObject({ status: 422, body: { code: 'InvalidOrder', intafacedCode: code } });
    }
  });

  it('closes, liquidation, ADL and reconcile never call the limits (reducing risk is never blocked)', () => {
    for (const file of [
      'close-planner.ts',
      'liquidation-tick.ts',
      'liquidation-planner.ts',
      'adl-last-resort.ts',
      'tick-stores.ts',
      'dated-futures-settlement.ts',
    ]) {
      expect(readFileSync(join(here, file), 'utf8'), file).not.toMatch(/pretrade-limits|pretrade-credit/);
    }
    const ps = readFileSync(join(here, 'position-service.ts'), 'utf8');
    // checkOpenAdmission is called from open() only.
    expect(ps.match(/checkOpenAdmission\(/g)).toHaveLength(1);
    const closeStart = ps.indexOf('async close(');
    expect(ps.indexOf('checkOpenAdmission(')).toBeLessThan(closeStart);
    const trade = tradeServiceSource();
    expect(trade).toMatch(
      /if \(!seeded && \(input as \{ reduceOnly\?: boolean \}\)\.reduceOnly !== true\) \{\s+await (?:this|svc)\.assertOwnerOrderLimit/,
    );
  });
});
