import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { afterFee, afterQuoteFee, aboutValue, costRows, limitFor, protectedTotal } from './cost';

describe('protectedTotal', () => {
  it('rounds the most a buyer can pay UP to the cent', () => {
    // 0.00123 * 65000.123 = 79.95015129 -> 79.96
    expect(protectedTotal('buy', '0.00123', '65000.123')).toBe('79.96');
  });
  it('rounds the least a seller gets DOWN to the cent', () => {
    expect(protectedTotal('sell', '0.00123', '65000.123')).toBe('79.95');
  });
  it('leaves an exact cent alone on both sides', () => {
    expect(protectedTotal('buy', '2', '1.25')).toBe('2.5');
    expect(protectedTotal('sell', '2', '1.25')).toBe('2.5');
  });
  it('is null without a protection price or amount', () => {
    expect(protectedTotal('buy', '1', null)).toBeNull();
    expect(protectedTotal('sell', 'x', '10')).toBeNull();
    expect(protectedTotal('buy', '1', '0')).toBeNull();
  });
});

describe('aboutValue / afterFee', () => {
  it('rounds the estimate down', () => {
    expect(aboutValue('0.5', '3.333')).toBe('1.6665');
    expect(aboutValue('x', '1')).toBeNull();
  });
  it('takes a fee in the bought coin off the amount', () => {
    expect(afterFee('0.0001', '0.00000008', 'BTC', 'BTC')).toBe('0.00009992');
  });
  it('knows nothing when the fee is in another asset, unknown or larger than the amount', () => {
    expect(afterFee('1', '0.1', 'USDT', 'BTC')).toBeNull();
    expect(afterFee('1', null, null, 'BTC')).toBeNull();
    expect(afterFee('1', '2', 'BTC', 'BTC')).toBeNull();
  });
  it('takes a fee in the paying money off a sell', () => {
    expect(afterQuoteFee('100', '0.1', 'USDT', 'USDT')).toBe('99.9');
    expect(afterQuoteFee('100', '0.1', 'BTC', 'USDT')).toBeNull();
  });
});

describe('costRows', () => {
  const base = { base: '0.001', price: '65000', baseAsset: 'BTC', quoteAsset: 'USDT' };
  it('buy with the fee in USDT: full coin amount, most you can pay rounded up', () => {
    const rows = costRows({
      ...base,
      side: 'buy',
      preview: { estimatedFee: '0.065', feeAsset: 'USDT', protectionPrice: '65325.001' },
    });
    expect(rows.estimated).toBe('65');
    expect(rows.fee).toEqual({ amount: '0.065', asset: 'USDT' });
    expect(rows.get).toEqual({ kind: 'coin', amount: '0.001', afterFee: false });
    // 0.001 * 65325.001 = 65.325001, plus the 0.065 USDT fee = 65.390001 -> 65.40
    expect(rows.limit).toBe('65.4');
  });
  it('buy with the fee in the coin: shows the amount after the fee', () => {
    const rows = costRows({ ...base, side: 'buy', preview: { estimatedFee: '0.000001', feeAsset: 'BTC', protectionPrice: '65000' } });
    expect(rows.get).toEqual({ kind: 'coin', amount: '0.000999', afterFee: true });
  });
  it('sell: least you get rounds down and the get line is money after a USDT fee', () => {
    const rows = costRows({ ...base, side: 'sell', preview: { estimatedFee: '0.065', feeAsset: 'USDT', protectionPrice: '64674.999' } });
    // 64.674999 - 0.065 = 64.609999 -> 64.6
    expect(rows.limit).toBe('64.6');
    expect(rows.get).toEqual({ kind: 'money', amount: '64.935' });
  });
  it('a fee in the coin leaves the money limit as before', () => {
    const buy = costRows({ ...base, side: 'buy', preview: { estimatedFee: '0.000001', feeAsset: 'BTC', protectionPrice: '65325.001' } });
    expect(buy.limit).toBe('65.33');
    const sell = costRows({ ...base, side: 'sell', preview: { estimatedFee: '0.000001', feeAsset: 'BTC', protectionPrice: '64674.999' } });
    expect(sell.limit).toBe('64.67');
  });
  it('sell never goes below zero when the fee is larger than the proceeds', () => {
    const rows = costRows({ ...base, side: 'sell', preview: { estimatedFee: '100', feeAsset: 'USDT', protectionPrice: '1000' } });
    expect(rows.limit).toBe('0');
  });
  it('an unknown fee leaves the limit unknown', () => {
    expect(costRows({ ...base, side: 'buy', preview: { estimatedFee: null, feeAsset: null, protectionPrice: '65000' } }).limit).toBeNull();
    expect(
      costRows({ ...base, side: 'sell', preview: { estimatedFee: '0.1', feeAsset: null, protectionPrice: '65000' } }).limit,
    ).toBeNull();
  });
  it('shows nothing for parts it cannot know', () => {
    const rows = costRows({ ...base, side: 'buy', price: null, preview: null });
    expect(rows).toEqual({ estimated: null, fee: null, get: null, limit: null });
    const noProtection = costRows({ ...base, side: 'buy', preview: { estimatedFee: null, feeAsset: null, protectionPrice: null } });
    expect(noProtection.limit).toBeNull();
    expect(noProtection.get).toBeNull();
    expect(noProtection.fee).toBeNull();
  });
});

describe('limitFor (the card and the review dialog share one worst case)', () => {
  it('counts a fee in the paying money, rounding the buy up and the sell down', () => {
    const fee = { estimatedFee: '0.065', feeAsset: 'USDT' };
    // 0.001 * 64674.999 = 64.674999, less the 0.065 USDT fee = 64.609999 -> 64.6 (the bare protectedTotal says 64.67)
    expect(limitFor('sell', '0.001', { ...fee, protectionPrice: '64674.999' }, 'USDT')).toBe('64.6');
    expect(limitFor('buy', '0.001', { ...fee, protectionPrice: '65325.001' }, 'USDT')).toBe('65.4');
  });
  it('stays unknown when the fee is unknown', () => {
    expect(limitFor('buy', '0.001', { estimatedFee: null, feeAsset: null, protectionPrice: '65000' }, 'USDT')).toBeNull();
  });
  it('is what costRows reports as the limit', () => {
    const preview = { estimatedFee: '0.065', feeAsset: 'USDT', protectionPrice: '64674.999' };
    const rows = costRows({ side: 'sell', base: '0.001', price: '65000', baseAsset: 'BTC', quoteAsset: 'USDT', preview });
    expect(rows.limit).toBe(limitFor('sell', '0.001', preview, 'USDT'));
  });
  it('BuyReview.tsx uses limitFor and never the bare 3-argument protectedTotal', () => {
    const source = readFileSync(new URL('./BuyReview.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/limitFor\(/);
    expect(source).not.toMatch(/protectedTotal\(/);
  });
});
