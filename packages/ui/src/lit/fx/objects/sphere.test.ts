import { describe, expect, it } from 'vitest';
import { sharesAddUp } from './sphere.js';

describe('sphere shares (charts reconcile to the total they show)', () => {
  it('accepts up to four parts that add up to 1', () => {
    expect(sharesAddUp([0.409, 0.34, 0.15, 0.101])).toBe(true);
    expect(sharesAddUp([1])).toBe(true);
  });
  it('refuses parts that leave money out, overcount, go negative or need a fifth segment', () => {
    expect(sharesAddUp([0.409, 0.34, 0.15])).toBe(false);
    expect(sharesAddUp([0.6, 0.6])).toBe(false);
    expect(sharesAddUp([1.2, -0.2])).toBe(false);
    expect(sharesAddUp([0.2, 0.2, 0.2, 0.2, 0.2])).toBe(false);
    expect(sharesAddUp([])).toBe(false);
  });
});
