import { describe, expect, it } from 'vitest';
import { secondsOf } from './OrderProtections';

describe('the edge window, in seconds exactly as it is held', () => {
  it('never rounds to a figure the edge does not enforce', () => {
    expect(secondsOf(60_000)).toBe('60');
    expect(secondsOf(1_500)).toBe('1.5');
    expect(secondsOf(400)).toBe('0.4');
    expect(secondsOf(61_005)).toBe('61.005');
  });
});
