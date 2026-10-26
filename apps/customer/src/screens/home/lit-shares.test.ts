import { describe, expect, it } from 'vitest';
import { sphereShares, type SpherePart } from './lit-shares';
import type { HomePortfolio } from './deps';

// a holding as the data layer gives it: the share of the total, and its USD value (here share × $10,000)
const holding = (asset: string, share: string | null, cls: 'cash' | 'crypto' = 'crypto') =>
  ({
    asset,
    share,
    class: cls,
    usdValue: share === null ? null : (Number(share) * 10_000).toFixed(2),
  }) as unknown as HomePortfolio['holdings'][number];
const sum = (parts: SpherePart[]) => parts.reduce((a, b) => a + b.percent, 0n);

describe('sphereShares', () => {
  it('splits the top three and the rest into "other", in whole percents adding up to 100, with their values', () => {
    const parts = sphereShares([
      holding('ETH', '0.2'),
      holding('BTC', '0.5'),
      holding('SOL', '0.1'),
      holding('LINK', '0.15'),
      holding('DOGE', '0.05'),
    ]);
    expect(parts).toEqual([
      { kind: 'asset', asset: 'BTC', percent: 50n, usd: '5000' },
      { kind: 'asset', asset: 'ETH', percent: 20n, usd: '2000' },
      { kind: 'asset', asset: 'LINK', percent: 15n, usd: '1500' },
      { kind: 'other', asset: null, percent: 15n, usd: '1500' },
    ]);
  });

  it('names stablecoins and fiat together as Cash, as the holdings rows do', () => {
    const parts = sphereShares([
      holding('BTC', '0.54'),
      holding('USDT', '0.2', 'cash'),
      holding('USD', '0.13', 'cash'),
      holding('ETH', '0.13'),
    ]);
    expect(parts).toEqual([
      { kind: 'asset', asset: 'BTC', percent: 54n, usd: '5400' },
      { kind: 'cash', asset: null, percent: 33n, usd: '3300' },
      { kind: 'asset', asset: 'ETH', percent: 13n, usd: '1300' },
    ]);
  });

  it('shows four parts by name, and folds only a fifth and beyond into "other"', () => {
    const parts = sphereShares([holding('BTC', '0.4'), holding('ETH', '0.3'), holding('SOL', '0.2'), holding('USDC', '0.1', 'cash')]);
    expect(parts!.map((p) => p.asset ?? p.kind)).toEqual(['BTC', 'ETH', 'SOL', 'cash']);
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
    expect(after!.map((p) => p.percent)).toEqual(before!.map((p) => p.percent));
    expect(before!.map((p) => [p.asset, p.percent])).toEqual([
      ['ETH', 59n],
      ['BTC', 41n],
    ]);
  });

  it('draws no segments when any holding has no known share', () => {
    expect(sphereShares([holding('BTC', '0.9'), holding('XYZ', null)])).toBeNull();
    expect(sphereShares([])).toBeNull();
    const unvalued = { ...holding('ETH', '0.1'), usdValue: null } as HomePortfolio['holdings'][number];
    expect(sphereShares([holding('BTC', '0.9'), unvalued])).toBeNull();
  });

  it('refuses shares that do not add up to the total', () => {
    expect(sphereShares([holding('BTC', '0.5'), holding('ETH', '0.3')])).toBeNull();
  });
});
