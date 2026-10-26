import { describe, expect, it } from 'vitest';
import { sphereShares, type SpherePart } from './lit-shares';
import type { HomePortfolio } from './deps';

const holding = (asset: string, share: string | null) => ({ asset, share }) as unknown as HomePortfolio['holdings'][number];
const sum = (parts: SpherePart[]) => parts.reduce((a, b) => a + b.percent, 0n);

describe('sphereShares', () => {
  it('splits the top three and the rest into "other", in whole percents adding up to 100', () => {
    const parts = sphereShares([
      holding('ETH', '0.2'),
      holding('BTC', '0.5'),
      holding('SOL', '0.1'),
      holding('USDC', '0.15'),
      holding('DOGE', '0.05'),
    ]);
    expect(parts).toEqual([
      { asset: 'BTC', percent: 50n },
      { asset: 'ETH', percent: 20n },
      { asset: 'USDC', percent: 15n },
      { asset: null, percent: 15n },
    ]);
  });

  it('keeps rounding drift from half-up shares inside the drawing', () => {
    const third = '0.333333333333333333';
    const parts = sphereShares([holding('A', third), holding('B', third), holding('C', third)]);
    expect(parts).not.toBeNull();
    expect(sum(parts!)).toBe(100n);
  });

  it('accepts half-up drift of one unit per holding, however many holdings there are', () => {
    const twelfth = '0.083333333333333334';
    const parts = sphereShares(Array.from({ length: 12 }, (_, i) => holding(`A${i}`, twelfth)));
    expect(parts).not.toBeNull();
    expect(sum(parts!)).toBe(100n);
  });

  it('keeps whole percents, so a share moving by a millionth draws the same split', () => {
    const before = sphereShares([holding('BTC', '0.409123'), holding('ETH', '0.590877')]);
    const after = sphereShares([holding('BTC', '0.409125'), holding('ETH', '0.590875')]);
    expect(after).toEqual(before);
    expect(before).toEqual([
      { asset: 'ETH', percent: 59n },
      { asset: 'BTC', percent: 41n },
    ]);
  });

  it('draws no segments when any holding has no known share', () => {
    expect(sphereShares([holding('BTC', '0.9'), holding('XYZ', null)])).toBeNull();
    expect(sphereShares([])).toBeNull();
  });

  it('refuses shares that do not add up to the total', () => {
    expect(sphereShares([holding('BTC', '0.5'), holding('ETH', '0.3')])).toBeNull();
  });
});
