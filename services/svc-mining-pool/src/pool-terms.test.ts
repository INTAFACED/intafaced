import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPoolTerms } from './pool-terms.js';

afterEach(() => vi.unstubAllEnvs());

describe('mining pool terms', () => {
  it('returns both values when both are set', () => {
    expect(readPoolTerms({ MINING_POOL_FEE_BPS: '100', MINING_POOL_WINDOW_SIZE: '30' })).toEqual({
      feeBps: 100,
      feeReason: null,
      windowSize: 30,
      windowSizeReason: null,
    });
    expect(readPoolTerms({ MINING_POOL_FEE_BPS: '0', MINING_POOL_WINDOW_SIZE: '1' }).feeBps).toBe(0);
    expect(readPoolTerms({ MINING_POOL_FEE_BPS: '9999', MINING_POOL_WINDOW_SIZE: '1440' }).feeBps).toBe(9999);
  });

  it('a blank fee or window size is null plus its typed reason, and the other value still returns', () => {
    expect(readPoolTerms({ MINING_POOL_FEE_BPS: '  ', MINING_POOL_WINDOW_SIZE: '8' })).toEqual({
      feeBps: null,
      feeReason: 'fee_unconfigured',
      windowSize: 8,
      windowSizeReason: null,
    });
    expect(readPoolTerms({ MINING_POOL_FEE_BPS: '100', MINING_POOL_WINDOW_SIZE: '' })).toMatchObject({
      feeBps: 100,
      windowSize: null,
      windowSizeReason: 'window_size_unconfigured',
    });
    expect(readPoolTerms({}).feeReason).toBe('fee_unconfigured');
    expect(readPoolTerms({}).windowSizeReason).toBe('window_size_unconfigured');
  });

  it('refuses a negative fee and 10000 bps the way planPplns does, and a non-positive window size', () => {
    for (const fee of ['-1', '10000', '10.5', 'abc', '0100']) {
      expect(readPoolTerms({ MINING_POOL_FEE_BPS: fee, MINING_POOL_WINDOW_SIZE: '8' })).toMatchObject({
        feeBps: null,
        feeReason: 'fee_unconfigured',
        windowSize: 8,
      });
    }
    for (const size of ['0', '-3', '1.5', 'abc']) {
      expect(readPoolTerms({ MINING_POOL_FEE_BPS: '100', MINING_POOL_WINDOW_SIZE: size })).toMatchObject({
        feeBps: 100,
        windowSize: null,
        windowSizeReason: 'window_size_unconfigured',
      });
    }
  });
});
