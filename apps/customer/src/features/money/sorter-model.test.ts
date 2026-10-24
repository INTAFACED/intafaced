import { describe, expect, it } from 'vitest';
import { bpToPercent, percentToBp, sorterLegs } from './sorter-model';

describe('income sorter percents', () => {
  it('reads a percent with up to two decimals as whole basis points, without a float', () => {
    expect(percentToBp('60')).toBe(6000);
    expect(percentToBp(' 33.33 ')).toBe(3333);
    expect(percentToBp('0.1')).toBe(10);
    expect(percentToBp('0.01')).toBe(1);
    expect(percentToBp('100')).toBe(10_000);
    for (const bad of ['0', '0.00', '100.01', '101', '1.234', '-5', '1e2', '', '12,5', '.5']) expect(percentToBp(bad)).toBeNull();
  });

  it('shows basis points as a percent', () => {
    expect(bpToPercent(6000)).toBe('60%');
    expect(bpToPercent(3333)).toBe('33.33%');
    expect(bpToPercent(1050)).toBe('10.5%');
    expect(bpToPercent(1)).toBe('0.01%');
  });

  it('skips blank fields and totals the rest, so a sorter over 100% can be named before it is sent', () => {
    expect(
      sorterLegs([
        { spaceId: 'a', text: '60' },
        { spaceId: 'b', text: '' },
        { spaceId: 'c', text: '50' },
      ]),
    ).toEqual({
      legs: [
        { spaceId: 'a', shareBp: 6000 },
        { spaceId: 'c', shareBp: 5000 },
      ],
      totalBp: 11_000,
    });
  });
});
