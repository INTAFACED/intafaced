import { describe, expect, it } from 'vitest';
import {
  HOME_TILES_MAX,
  HOME_TILES_NAMESPACE,
  homeTilesPreferenceSchema,
  homeTilesRequestId,
  homeTilesValueSchema,
} from './home-tiles-preferences.js';
import * as root from './index.js';

describe('home.tiles record (HM-widgets-01)', () => {
  it('accepts an order and a hidden set, either of them empty', () => {
    expect(homeTilesValueSchema.safeParse({ order: ['activity', 'markets'], hidden: ['markets'] }).success).toBe(true);
    expect(homeTilesValueSchema.safeParse({ order: [], hidden: [] }).success).toBe(true);
  });
  it.each([
    { order: ['markets', 'markets'], hidden: [] },
    { order: [], hidden: ['a', 'a'] },
    { order: ['Markets'], hidden: [] },
    { order: ['has space'], hidden: [] },
    { order: [], hidden: [], extra: true },
    { order: [] },
    { order: Array.from({ length: HOME_TILES_MAX + 1 }, (_, i) => `t${i}`), hidden: [] },
  ])('refuses %j', (value) => {
    expect(homeTilesValueSchema.safeParse(value).success).toBe(false);
  });
  it('is the shape the preferences door returns for this namespace', () => {
    expect(homeTilesPreferenceSchema.safeParse({ namespace: HOME_TILES_NAMESPACE, version: 0, value: null }).success).toBe(true);
    expect(homeTilesPreferenceSchema.safeParse({ namespace: 'ui.view', version: 0, value: null }).success).toBe(false);
  });
  it('names a write by person, version and layout, never at random', () => {
    const layout = { order: ['markets'], hidden: ['learn'] };
    expect(homeTilesRequestId('ABC', 3, layout)).toMatch(/^home-tiles:abc:3:[0-9a-f]{16}$/);
    expect(homeTilesRequestId('ABC', 3, layout)).toBe(homeTilesRequestId('abc', 3, { order: ['markets'], hidden: ['learn'] }));
    expect(homeTilesRequestId('abc', 4, layout)).not.toBe(homeTilesRequestId('abc', 3, layout));
    // Two devices writing different layouts at the same version get different ids.
    expect(homeTilesRequestId('abc', 3, { order: [], hidden: ['markets'] })).not.toBe(homeTilesRequestId('abc', 3, layout));
    expect(homeTilesRequestId('abc', 3, { order: ['a', 'b'], hidden: [] })).not.toBe(
      homeTilesRequestId('abc', 3, { order: ['a'], hidden: ['b'] }),
    );
  });
  it('is reachable from the package root too', () => {
    expect(root.HOME_TILES_NAMESPACE).toBe(HOME_TILES_NAMESPACE);
  });
});
