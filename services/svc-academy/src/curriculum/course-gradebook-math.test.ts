import { describe, expect, it } from 'vitest';
import { fractionOf, fractionText, typeAverage, weightedTotal, weightsSumToOne } from './course-gradebook-math.js';

const f = (score: string, points: string) => fractionOf(score, points)!;

describe('gradebook arithmetic (AC-assignments-04)', () => {
  it('adds weights exactly: 0.4, 0.4 and 0.3 is not 1; 0.4, 0.4 and 0.2 is', () => {
    expect(weightsSumToOne(['0.4', '0.4', '0.3'])).toBe(false);
    expect(weightsSumToOne(['0.4', '0.4', '0.2'])).toBe(true);
    expect(weightsSumToOne(['0.1', '0.2', '0.7'])).toBe(true);
  });

  it('drops the lowest before averaging, never the last score', () => {
    const scores = [
      { itemId: 'a', score: f('10', '10') },
      { itemId: 'b', score: f('5', '10') },
      { itemId: 'c', score: f('8', '10') },
    ];
    const one = typeAverage(scores, 1);
    expect(fractionText(one.average!)).toBe('0.9');
    expect(one).toMatchObject({ counted: ['a', 'c'], dropped: ['b'] });
    expect(typeAverage([{ itemId: 'a', score: f('3', '10') }], 2)).toMatchObject({ counted: ['a'], dropped: [] });
    expect(typeAverage([], 1).average).toBeNull();
  });

  it('weights the types that have an average and cuts thirds rather than rounding', () => {
    expect(
      fractionText(
        weightedTotal([
          { weight: '0.6', average: f('9', '10') },
          { weight: '0.4', average: f('1', '1') },
        ])!,
      ),
    ).toBe('0.94');
    // A type with nothing graded is left out, not counted as zero.
    expect(
      fractionText(
        weightedTotal([
          { weight: '0.6', average: f('9', '10') },
          { weight: '0.4', average: null },
        ])!,
      ),
    ).toBe('0.9');
    expect(weightedTotal([{ weight: '1', average: null }])).toBeNull();
    expect(fractionText(f('1', '3'))).toBe('0.333333333333333333');
  });
});
