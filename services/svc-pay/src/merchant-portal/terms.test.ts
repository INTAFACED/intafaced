import { describe, expect, it } from 'vitest';
import { readMerchantTerms } from './terms.js';

describe('the published merchant terms', () => {
  it('is none while both settings are blank, and never a default', () => {
    expect(readMerchantTerms({})).toBeNull();
    expect(readMerchantTerms({ PAY_MERCHANT_TERMS_VERSION: ' ', PAY_MERCHANT_TERMS_URL: '' })).toBeNull();
  });
  it('reads a version and the address to read it at', () => {
    expect(readMerchantTerms({ PAY_MERCHANT_TERMS_VERSION: ' v1.2 ', PAY_MERCHANT_TERMS_URL: 'https://terms.example/v1.2' })).toEqual({
      version: 'v1.2',
      url: 'https://terms.example/v1.2',
    });
  });
  it('refuses to boot on half a setting or a malformed one', () => {
    expect(() => readMerchantTerms({ PAY_MERCHANT_TERMS_VERSION: 'v1' })).toThrow(/together/);
    expect(() => readMerchantTerms({ PAY_MERCHANT_TERMS_URL: 'https://terms.example' })).toThrow(/together/);
    expect(() => readMerchantTerms({ PAY_MERCHANT_TERMS_VERSION: 'v 1', PAY_MERCHANT_TERMS_URL: 'https://terms.example' })).toThrow(
      /letters/,
    );
    expect(() => readMerchantTerms({ PAY_MERCHANT_TERMS_VERSION: 'v1', PAY_MERCHANT_TERMS_URL: '/terms' })).toThrow(/absolute/);
    expect(() => readMerchantTerms({ PAY_MERCHANT_TERMS_VERSION: 'v1', PAY_MERCHANT_TERMS_URL: 'javascript:alert(1)' })).toThrow(/https/);
    expect(() => readMerchantTerms({ PAY_MERCHANT_TERMS_VERSION: 'v1', PAY_MERCHANT_TERMS_URL: 'http://terms.example/v1' })).toThrow(
      /https/,
    );
  });
  it('honours a TEST version only on the local test stack', () => {
    const env = {
      PAY_MERCHANT_TERMS_VERSION: 'TEST-merchant-terms-1',
      PAY_MERCHANT_TERMS_URL: 'https://terms.example/TEST-merchant-terms-1',
    };
    expect(readMerchantTerms({ ...env, APP_ENV: 'dev' })?.version).toBe('TEST-merchant-terms-1');
    expect(readMerchantTerms({ ...env, APP_ENV: 'test' })?.version).toBe('TEST-merchant-terms-1');
    for (const APP_ENV of ['production', 'staging', undefined])
      expect(() => readMerchantTerms({ ...env, APP_ENV })).toThrow(/TEST version/);
  });
});
