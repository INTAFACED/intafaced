import { describe, expect, it } from 'vitest';
import type { Holding } from '../../../data/types';
import { availableUsd } from './account';

const holding = (asset: string, total: string, available: string, usdValue: string | null): Holding => ({
  asset,
  class: 'crypto',
  total,
  available,
  inOrders: '0',
  usdValue,
  usdChange24h: null,
  share: null,
  priceSymbol: null,
});

describe('availableUsd', () => {
  it('values only the free share of each priced holding, in exact decimals', () => {
    const result = availableUsd({
      totalUsd: '10000',
      holdings: [holding('USDT', '9000', '4100', '9000'), holding('BTC', '0.015', '0.01', '1000')],
    });
    // 4100 + 1000 * (0.01 / 0.015) = 4100 + 666.666666666666666667 (half-up at 18 places)
    expect(result.value).toBe('4766.666666666666666667');
    expect(result.partial).toBe(false);
  });

  it('is a plain zero for an account that holds nothing', () => {
    expect(availableUsd({ totalUsd: '0', holdings: [] })).toEqual({ value: '0', partial: false });
  });

  it('is unknown, not zero, when the total itself is unknown and nothing could be valued', () => {
    expect(availableUsd({ totalUsd: null, holdings: [] })).toEqual({ value: null, partial: false });
  });

  it('flags a holding with money free but no price, and leaves it out rather than guessing', () => {
    const result = availableUsd({
      totalUsd: '100',
      holdings: [holding('USDT', '100', '100', '100'), holding('XYZ', '5', '5', null)],
    });
    expect(result).toEqual({ value: '100', partial: true });
  });

  it('does not flag an unpriced holding that has nothing free', () => {
    const result = availableUsd({ totalUsd: '100', holdings: [holding('USDT', '100', '100', '100'), holding('XYZ', '5', '0', null)] });
    expect(result.partial).toBe(false);
  });

  it('skips malformed amounts instead of throwing', () => {
    const result = availableUsd({ totalUsd: '10', holdings: [holding('BAD', 'abc', '1', '5'), holding('USDT', '10', '10', '10')] });
    expect(result.value).toBe('10');
  });
});
