import { describe, expect, it } from 'vitest';
import { findRoom } from '../../app/navigation';
import { isFeatureLive, isHiddenPath } from '../../app/feature-registry';
import { moreCopy } from './copy';
import { TILES, visibleSections } from './tiles';

const allLive = { hidden: () => false, featureLive: () => true };

describe('More tiles (UI-SPEC 5.11)', () => {
  it('draws Account, Settings and Help in that order, with the spec tiles', () => {
    const groups = visibleSections(allLive);
    expect(groups.map((group) => group.section)).toEqual(['Account', 'Settings', 'Help']);
    expect(groups.map((group) => group.tiles.map((tile) => tile.id))).toEqual([
      ['account', 'security', 'verification'],
      ['display', 'notifications'],
      ['help'],
    ]);
  });

  it('drops a tile whose screen is hidden or whose registry feature is not live, and a section left empty', () => {
    const groups = visibleSections({ hidden: (path) => path === '/view', featureLive: (id) => id !== 'help-support' });
    expect(groups.map((group) => group.section)).toEqual(['Account', 'Settings']);
    expect(groups[1]!.tiles.map((tile) => tile.id)).toEqual(['notifications']);
  });

  it('every tile that renders today opens a real screen: not hidden, not an alias (no redirect)', () => {
    const shown = visibleSections().flatMap((group) => group.tiles);
    expect(shown.length).toBeGreaterThan(0);
    for (const tile of shown) {
      const room = findRoom(tile.href);
      expect(room, tile.href).toBeDefined();
      expect(room?.alias, `${tile.href} redirects`).toBeUndefined();
      expect(room?.area, tile.href).not.toBe('public');
      expect(isHiddenPath(tile.href), tile.href).toBe(false);
    }
  });

  it('Help goes to the signed-in help screen, not the public page that says "Sign in"', () => {
    expect(TILES.find((tile) => tile.id === 'help')?.href).toBe('/support');
    expect(isFeatureLive('help-support')).toBe(true);
  });

  it('has a plain-words line for every tile and none of the banned words', () => {
    const banned = /unavailable|not connected|restricted|fixture|lifecycle|\broom\b|\bledger\b|\btier\b/i;
    for (const tile of TILES) {
      for (const key of [tile.title, tile.line]) {
        const text = moreCopy.t(key);
        expect(text, key).not.toBe('');
        expect(text, key).not.toMatch(banned);
      }
    }
  });
});
