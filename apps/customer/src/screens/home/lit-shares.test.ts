import { describe, expect, it } from 'vitest';
import { sphereShares } from './lit-shares';
import type { HomePortfolio } from './deps';

const holding = (asset: string, share: string | null) => ({ asset, share }) as unknown as HomePortfolio['holdings'][number];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('sphereShares', () => {
  it('splits the top three and the rest into "other", adding up to the whole', () => {
    const parts = sphereShares([
      holding('ETH', '0.2'),
      holding('BTC', '0.5'),
      holding('SOL', '0.1'),
      holding('USDC', '0.15'),
      holding('DOGE', '0.05'),
    ]);
    expect(parts).not.toBeNull();
    expect(parts!.length).toBe(4);
    expect(parts![0]).toBeCloseTo(0.5, 6);
    expect(parts![3]).toBeCloseTo(0.15, 6);
    expect(sum(parts!)).toBeCloseTo(1, 12);
  });

  it('keeps rounding drift from half-up shares inside the drawing', () => {
    const third = '0.333333333333333333';
    const parts = sphereShares([holding('A', third), holding('B', third), holding('C', third)]);
    expect(parts).not.toBeNull();
    expect(sum(parts!)).toBeCloseTo(1, 12);
  });

  it('draws no segments when any holding has no known share', () => {
    expect(sphereShares([holding('BTC', '0.9'), holding('XYZ', null)])).toBeNull();
    expect(sphereShares([])).toBeNull();
  });

  it('refuses shares that do not add up to the total', () => {
    expect(sphereShares([holding('BTC', '0.5'), holding('ETH', '0.3')])).toBeNull();
  });
});
