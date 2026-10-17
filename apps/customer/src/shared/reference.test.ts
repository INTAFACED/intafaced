import { describe, expect, it } from 'vitest';
import { shortReference } from './reference';

describe('short reference for a long identifier', () => {
  it('keeps the first eight letters and digits, in capitals', () => {
    expect(shortReference('3f2a9c1e-7b44-4d0a-9c1e-0a1b2c3d4e5f')).toBe('3F2A9C1E');
  });
  it('copes with short or odd input', () => {
    expect(shortReference('abc')).toBe('ABC');
    expect(shortReference('')).toBe('');
    expect(shortReference('--')).toBe('');
  });
});
