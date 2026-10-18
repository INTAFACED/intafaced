import { describe, expect, it } from 'vitest';
import { MerchantStarterFeeBootError, MerchantStoredFeeError, merchantFeeView, readMerchantStarterFee } from './starter-fee.js';

describe('PAY_MERCHANT_STARTER_FEE_BPS', () => {
  it('stays unset on every APP_ENV when the variable is missing or blank', () => {
    for (const APP_ENV of [undefined, '', 'dev', 'test', 'staging', 'prod', 'production'] as const) {
      const env = APP_ENV === undefined ? {} : { APP_ENV };
      expect(readMerchantStarterFee(env)).toBeNull();
      expect(readMerchantStarterFee({ ...env, PAY_MERCHANT_STARTER_FEE_BPS: '   ' })).toBeNull();
    }
  });

  it('honours an integer only when APP_ENV is exactly dev or test', () => {
    expect(readMerchantStarterFee({ APP_ENV: 'dev', PAY_MERCHANT_STARTER_FEE_BPS: '250' })).toEqual({
      bps: 250,
      source: 'local_test',
    });
    expect(readMerchantStarterFee({ APP_ENV: 'test', PAY_MERCHANT_STARTER_FEE_BPS: '0' })).toEqual({
      bps: 0,
      source: 'local_test',
    });
  });

  it('refuses to boot when the variable is set and APP_ENV is staging, production, or unset', () => {
    for (const APP_ENV of ['staging', 'prod', 'production', undefined, '', '  ', 'DEV'] as const) {
      const env = APP_ENV === undefined ? { PAY_MERCHANT_STARTER_FEE_BPS: '250' } : { APP_ENV, PAY_MERCHANT_STARTER_FEE_BPS: '250' };
      expect(() => readMerchantStarterFee(env)).toThrow(MerchantStarterFeeBootError);
      expect(() => readMerchantStarterFee(env)).toThrow(/not INTAFACED pricing/);
      expect(() => readMerchantStarterFee(env)).toThrow(/Refusing to boot/);
    }
  });

  it('refuses a non-integer on the local test stack instead of treating it as unset or zero', () => {
    for (const raw of ['nope', '2.5', '-1', '10001', '1e2']) {
      expect(() => readMerchantStarterFee({ APP_ENV: 'dev', PAY_MERCHANT_STARTER_FEE_BPS: raw })).toThrow(MerchantStarterFeeBootError);
    }
  });
});

describe('merchantFeeView', () => {
  const starter = { bps: 250, source: 'local_test' as const };

  it('returns the stored fee beside the published starter fee', () => {
    expect(merchantFeeView({ feeBps: 150 }, starter)).toEqual({ feeBps: 150, starterFee: starter });
    expect(merchantFeeView({ feeBps: 0 }, starter)).toEqual({ feeBps: 0, starterFee: starter });
  });

  it('returns null when the stored fee or the starter fee is unset', () => {
    expect(merchantFeeView({}, null)).toEqual({ feeBps: null, starterFee: null });
    expect(merchantFeeView(null, null)).toEqual({ feeBps: null, starterFee: null });
    expect(merchantFeeView({}, starter)).toEqual({ feeBps: null, starterFee: starter });
  });

  it('refuses a stored fee that is not an integer from 0 to 10000', () => {
    for (const pricing of [{ feeBps: 1.5 }, { feeBps: -1 }, { feeBps: 10_001 }, { feeBps: '250' }, { feeBps: null }]) {
      expect(() => merchantFeeView(pricing, null)).toThrow(MerchantStoredFeeError);
    }
  });
});
