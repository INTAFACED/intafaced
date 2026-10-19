import { describe, expect, it } from 'vitest';
import { MAX_FEE_BPS } from './fee-bps-bound.js';
import { publishedDefaultFeeBps } from './payment-service.js';
import { MerchantStoredFeeError, normalizeStoredFeeBps, readMerchantStarterFee } from './starter-fee.js';
import { resolveSubscriptionFeeBps } from './subscriptions/charge-cycle.js';

describe('merchant fee bound is 9999 bps, as in svc-p2p', () => {
  it('a 100% fee would net every settlement window to zero, so it is refused where it is set', () => {
    expect(MAX_FEE_BPS).toBe(9_999);
    expect(publishedDefaultFeeBps(9_999)).toBe(9_999);
    expect(() => publishedDefaultFeeBps(10_000)).toThrow(/pay.merchant_pricing_invalid|0 and 9999/);
    expect(normalizeStoredFeeBps({ feeBps: 9_999 })).toBe(9_999);
    expect(() => normalizeStoredFeeBps({ feeBps: 10_000 })).toThrow(MerchantStoredFeeError);
    expect(readMerchantStarterFee({ APP_ENV: 'test', PAY_MERCHANT_STARTER_FEE_BPS: '9999' })).toEqual({ bps: 9_999, source: 'local_test' });
    expect(() => readMerchantStarterFee({ APP_ENV: 'test', PAY_MERCHANT_STARTER_FEE_BPS: '10000' })).toThrow();
    expect(resolveSubscriptionFeeBps({ merchantFeeBps: 9_999 })).toBe(9_999);
    expect(() => resolveSubscriptionFeeBps({ merchantFeeBps: 10_000 })).toThrow(/9999/);
  });
});
