import { describe, expect, it } from 'vitest';
import { takingIn } from './chart-overlay';

describe('takingIn: the price scale takes in the lines as well as the bars', () => {
  it('widens the bars’ range to every line', () => {
    expect(takingIn([95, 110])(() => ({ priceRange: { minValue: 100, maxValue: 101 } }))).toEqual({
      priceRange: { minValue: 95, maxValue: 110 },
    });
  });

  it('answers the lines’ own range while the series has no bars: a null answer or a null range', () => {
    expect(takingIn([95, 110])(() => null).priceRange).toEqual({ minValue: 95, maxValue: 110 });
    expect(takingIn([95, 110])(() => ({ priceRange: null })).priceRange).toEqual({ minValue: 95, maxValue: 110 });
  });
});
