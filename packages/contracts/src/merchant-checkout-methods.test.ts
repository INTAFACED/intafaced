import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_METHODS,
  checkoutMethodRuleSchema,
  checkoutMethodsPreviewInputSchema,
  checkoutMethodsSaveInputSchema,
} from './merchant-checkout-methods.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const rule = (method: string, over: Record<string, unknown> = {}) => ({
  method,
  enabled: true,
  ruleAsset: null,
  minAmount: null,
  maxAmount: null,
  ...over,
});

describe('merchantCheckoutMethods (M-adv-payments-core-11)', () => {
  it('takes every catalogue method exactly once, in any order', () => {
    const methods = [...CHECKOUT_METHODS].reverse().map((m) => rule(m));
    expect(checkoutMethodsSaveInputSchema.parse({ requestId, expectedVersion: 0, methods }).methods.map((m) => m.method)).toEqual([
      'pay_later',
      'bank_debit',
      'card',
      'crypto',
    ]);
    const twice = [rule('crypto'), rule('crypto'), rule('card'), rule('bank_debit')];
    expect(checkoutMethodsSaveInputSchema.safeParse({ requestId, expectedVersion: 0, methods: twice }).success).toBe(false);
    expect(checkoutMethodsSaveInputSchema.safeParse({ requestId, expectedVersion: 0, methods: methods.slice(1) }).success).toBe(false);
  });

  it('keeps a minimum and maximum as decimal strings in a named asset, and blank as no rule', () => {
    expect(checkoutMethodRuleSchema.parse(rule('crypto', { ruleAsset: ' usdt ', minAmount: '5', maxAmount: '1000.5' }))).toMatchObject({
      ruleAsset: 'USDT',
      minAmount: '5',
      maxAmount: '1000.5',
    });
    expect(checkoutMethodRuleSchema.safeParse(rule('crypto', { minAmount: '5' })).success).toBe(false);
    expect(checkoutMethodRuleSchema.safeParse(rule('crypto', { ruleAsset: 'USDT' })).success).toBe(false);
    for (const amount of [5, '0', '-1', '1e3', '1.0000000000000000001', ''])
      expect(checkoutMethodRuleSchema.safeParse(rule('crypto', { ruleAsset: 'USDT', minAmount: amount })).success, String(amount)).toBe(
        false,
      );
  });

  it('reads a preview country as two letters in upper case', () => {
    expect(checkoutMethodsPreviewInputSchema.parse({ country: 'de', currency: 'eur' })).toEqual({ country: 'DE', currency: 'EUR' });
    expect(checkoutMethodsPreviewInputSchema.safeParse({ country: 'DEU', currency: 'EUR' }).success).toBe(false);
  });
});
