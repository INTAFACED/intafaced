import { describe, expect, it } from 'vitest';
import { checkSplitAtCreation, planSplitRefund, SplitRefusal, type SplitInput } from './split-plan.js';

const base: SplitInput = {
  paymentAmount: '100',
  asset: 'USDC',
  settlingParty: 'self',
  platformFee: { amount: '10', asset: 'USDC' },
  shares: [
    { subMerchantId: 'a', amount: '60', asset: 'USDC' },
    { subMerchantId: 'b', amount: '30', asset: 'USDC' },
  ],
};
function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SplitRefusal);
    return (e as SplitRefusal).code;
  }
  throw new Error('expected refusal');
}

describe('checkSplitAtCreation', () => {
  it('a split that adds up still refuses: fee table not set', () => {
    expect(code(() => checkSplitAtCreation(base, null))).toBe('pay.split_fee_table_not_set');
    expect(code(() => checkSplitAtCreation(base, { published: true }))).toBe('pay.split_fee_table_not_set');
  });
  it('refuses shares that do not add up, before the fee table', () => {
    expect(code(() => checkSplitAtCreation({ ...base, paymentAmount: '101' }, null))).toBe('pay.split_sum_mismatch');
  });
  it('refuses more than one asset', () => {
    expect(code(() => checkSplitAtCreation({ ...base, platformFee: { amount: '10', asset: 'USDT' } }, null))).toBe('pay.split_multi_asset');
  });
  it('refuses a duplicate sub-merchant', () => {
    expect(code(() => checkSplitAtCreation({ ...base, shares: [base.shares[0]!, { ...base.shares[1]!, subMerchantId: 'a' }] }, null))).toBe(
      'pay.split_duplicate_party',
    );
  });
  it('refuses settlingParty other than self', () => {
    expect(code(() => checkSplitAtCreation({ ...base, settlingParty: 'partner' }, null))).toBe('pay.split_settling_party_unsupported');
  });
  it('refuses bad, negative, zero and empty inputs', () => {
    expect(code(() => checkSplitAtCreation({ ...base, paymentAmount: 'abc' }, null))).toBe('pay.split_invalid_amount');
    expect(code(() => checkSplitAtCreation({ ...base, paymentAmount: '0' }, null))).toBe('pay.split_invalid_amount');
    expect(code(() => checkSplitAtCreation({ ...base, shares: [] }, null))).toBe('pay.split_invalid_amount');
    expect(code(() => checkSplitAtCreation({ ...base, platformFee: { amount: '-1', asset: 'USDC' } }, null))).toBe(
      'pay.split_invalid_amount',
    );
  });
});

describe('planSplitRefund', () => {
  const p = {
    paymentAmount: '100',
    platformFee: '10',
    shares: [
      { subMerchantId: 'a', amount: '60' },
      { subMerchantId: 'b', amount: '30' },
    ],
  };
  it('reduces each share in proportion', () => {
    expect(planSplitRefund({ ...p, refundAmount: '50', balances: { a: '100', b: '100' } })).toEqual({
      lines: [
        { party: 'a', amount: '30' },
        { party: 'b', amount: '15' },
        { party: 'platform', amount: '5' },
      ],
      roundingToPlatform: '0',
    });
  });
  it('rounding remainder goes to the platform and is stated', () => {
    const r = planSplitRefund({
      paymentAmount: '3',
      platformFee: '1',
      shares: [
        { subMerchantId: 'a', amount: '1' },
        { subMerchantId: 'b', amount: '1' },
      ],
      refundAmount: '1',
      balances: { a: '1', b: '1' },
    });
    expect(r.lines.at(-1)).toEqual({ party: 'platform', amount: '0.333333333333333334' });
    expect(r.roundingToPlatform).toBe('0.000000000000000001');
  });
  it('refuses naming the short party, no partial plan', () => {
    try {
      planSplitRefund({ ...p, refundAmount: '50', balances: { a: '100', b: '1' } });
      throw new Error('no');
    } catch (e) {
      expect((e as SplitRefusal).code).toBe('pay.split_refund_balance_short');
      expect((e as SplitRefusal).detail.subMerchantId).toBe('b');
    }
  });
  it('refuses a refund above the payment, and zero', () => {
    expect(code(() => planSplitRefund({ ...p, refundAmount: '101', balances: {} }))).toBe('pay.split_refund_exceeds_payment');
    expect(code(() => planSplitRefund({ ...p, refundAmount: '0', balances: {} }))).toBe('pay.split_invalid_amount');
  });
});
