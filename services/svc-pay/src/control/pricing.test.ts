import { describe, expect, it } from 'vitest';
import { formatAmount as f, parseAmount as a } from '@intafaced/ledger-client';
import { assertValidRule, computePricing, computeReserve, PricingConfigError, resolvePricingRule, type PricingRule } from './pricing.js';
import { payoutPayloadHash } from './approval-gate.js';

/**
 * TEST VALUES ONLY. Nothing below is a real fee, spread, band or reserve: no
 * business number is agreed. Expected results are worked out by hand in the
 * comments, not by calling the engine.
 */
const rule = (over: Partial<PricingRule> = {}): PricingRule => ({
  id: '11111111-1111-4111-8111-111111111111',
  layer: 'global',
  scopeId: '',
  assetCode: 'USDT',
  bands: [
    { fromAmount: a('0'), feeBps: 250, flatFee: a('0.3') },
    { fromAmount: a('10000'), feeBps: 200, flatFee: a('0.3') },
    { fromAmount: a('100000'), feeBps: 150, flatFee: null },
  ],
  spreadBps: 40,
  roundingBeneficiary: 'platform',
  minFee: a('0.5'),
  maxFee: a('500'),
  version: 1n,
  ...over,
});

describe('pricing engine: golden values', () => {
  it('first band: 100 at 250 bps + 0.30 flat = 2.5 + 0.3 = 2.8; conversion spread 40 bps = 0.4; net 96.8', () => {
    const q = computePricing(rule(), { amount: a('100'), monthlyVolumeBefore: 0n, conversion: true });
    expect(f(q.bpsFee)).toBe('2.5');
    expect(f(q.fee)).toBe('2.8');
    expect(f(q.spread!)).toBe('0.4');
    expect(f(q.net)).toBe('96.8');
    expect(q.feeBps).toBe(250);
    expect(q.roundingMode).toBe('ceil');
  });

  it('no spread unless it is a conversion', () => {
    const q = computePricing(rule(), { amount: a('100'), monthlyVolumeBefore: 0n });
    expect(q.spread).toBeNull();
    expect(f(q.net)).toBe('97.2');
  });

  it('band edges: the band reached by month-to-date volume prices the whole item', () => {
    // 1000 at 200 bps = 20 + 0.3 flat = 20.3 (band starts at exactly 10000)
    expect(f(computePricing(rule(), { amount: a('1000'), monthlyVolumeBefore: a('10000') }).fee)).toBe('20.3');
    // one minor unit below the edge is still the first band: 1000 x 250 bps = 25 + 0.3
    expect(f(computePricing(rule(), { amount: a('1000'), monthlyVolumeBefore: a('9999.999999999999999999') }).fee)).toBe('25.3');
    // third band has no flat fee: 1000 x 150 bps = 15
    const third = computePricing(rule(), { amount: a('1000'), monthlyVolumeBefore: a('100000') });
    expect(f(third.fee)).toBe('15');
    expect(third.bandFrom).toBe(a('100000'));
  });

  it('min and max fee clamp: 1 -> 0.025 + 0.3 = 0.325 raised to 0.5; 1,000,000 in band three = 15000 capped at 500', () => {
    const low = computePricing(rule(), { amount: a('1'), monthlyVolumeBefore: 0n });
    expect(f(low.feeBeforeClamp)).toBe('0.325');
    expect(f(low.fee)).toBe('0.5');
    const high = computePricing(rule(), { amount: a('1000000'), monthlyVolumeBefore: a('100000') });
    expect(f(high.feeBeforeClamp)).toBe('15000');
    expect(f(high.fee)).toBe('500');
  });

  it('rounding direction is the configured one: 1 minor unit x 250 bps = 0.025 unit -> platform keeps it (1), merchant keeps it (0)', () => {
    const bare = { bands: [{ fromAmount: 0n, feeBps: 250, flatFee: null }], minFee: null, maxFee: null, spreadBps: null };
    const one = a('0.000000000000000001');
    const platform = computePricing(rule({ ...bare, roundingBeneficiary: 'platform' }), { amount: one, monthlyVolumeBefore: 0n });
    const merchant = computePricing(rule({ ...bare, roundingBeneficiary: 'merchant' }), { amount: one, monthlyVolumeBefore: 0n });
    expect(platform.fee).toBe(1n);
    expect(platform.roundingMode).toBe('ceil');
    expect(merchant.fee).toBe(0n);
    expect(merchant.roundingMode).toBe('floor');
  });

  it('an unset or unknown rounding beneficiary is refused, never defaulted', () => {
    const broken = rule({ roundingBeneficiary: undefined as never });
    expect(() => computePricing(broken, { amount: a('1'), monthlyVolumeBefore: 0n })).toThrow(PricingConfigError);
  });

  it('invalid rules are refused: first band not 0, bands out of order, min above max', () => {
    expect(() => assertValidRule(rule({ bands: [{ fromAmount: a('1'), feeBps: 1, flatFee: null }] }))).toThrow(/start at 0/);
    expect(() =>
      assertValidRule(
        rule({
          bands: [
            { fromAmount: 0n, feeBps: 1, flatFee: null },
            { fromAmount: 0n, feeBps: 2, flatFee: null },
          ],
        }),
      ),
    ).toThrow(/ascending/);
    expect(() => assertValidRule(rule({ minFee: a('2'), maxFee: a('1') }))).toThrow(/minFee/);
  });
});

describe('pricing layers: global -> tier -> merchant, the most specific whole rule wins', () => {
  const g = rule({ id: 'g', layer: 'global' });
  const t = rule({ id: 't', layer: 'tier', scopeId: 'tier-x' });
  const m = rule({ id: 'm', layer: 'merchant', scopeId: 'mer' });
  it('picks merchant over tier over global and returns the chain', () => {
    const r = resolvePricingRule([g, t, m], 'USDT')!;
    expect(r.rule.id).toBe('m');
    expect(r.chain.map((c) => c.ruleId)).toEqual(['g', 't', 'm']);
    expect(resolvePricingRule([g, t], 'USDT')!.rule.id).toBe('t');
    expect(resolvePricingRule([g], 'USDT')!.rule.id).toBe('g');
  });
  it('no rule for the asset = null (the caller refuses)', () => {
    expect(resolvePricingRule([g], 'USD')).toBeNull();
    expect(resolvePricingRule([], 'USDT')).toBeNull();
  });
});

describe('rolling reserve', () => {
  const at = new Date('2026-10-15T00:00:00Z');
  it('1000 bps of net 96.8 = 9.68, released after 7 days', () => {
    const q = computeReserve(a('96.8'), { bps: 1000, holdDays: 7 }, 'platform', at);
    expect(f(q.amount)).toBe('9.68');
    expect(q.releaseAt.toISOString()).toBe('2026-10-22T00:00:00.000Z');
  });
  it('rounds with the beneficiary: 1 minor unit x 1000 bps = 0.1 unit -> platform holds 1, merchant 0', () => {
    expect(computeReserve(1n, { bps: 1000, holdDays: 1 }, 'platform', at).amount).toBe(1n);
    expect(computeReserve(1n, { bps: 1000, holdDays: 1 }, 'merchant', at).amount).toBe(0n);
  });
});

describe('payout payload hash binds amount, asset, rail and destination', () => {
  const base = {
    merchantId: '22222222-2222-4222-8222-222222222222',
    settlementId: '33333333-3333-4333-8333-333333333333',
    assetCode: 'USDT',
    amount: a('60'),
    railId: 'crypto-native',
    destination: { kind: 'crypto', ref: '0xAbC' },
  };
  it('changes with any field; ignores destination casing', () => {
    const h = payoutPayloadHash(base);
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(payoutPayloadHash({ ...base, amount: a('60.000000000000000001') })).not.toBe(h);
    expect(payoutPayloadHash({ ...base, destination: { kind: 'crypto', ref: '0xdef' } })).not.toBe(h);
    expect(payoutPayloadHash({ ...base, railId: 'bank-payout' })).not.toBe(h);
    expect(payoutPayloadHash({ ...base, assetCode: 'USD' })).not.toBe(h);
    expect(payoutPayloadHash({ ...base, destination: { kind: 'CRYPTO', ref: ' 0xABC ' } })).toBe(h);
  });
});
