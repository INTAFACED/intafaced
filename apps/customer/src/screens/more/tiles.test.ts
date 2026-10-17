import { describe, expect, it } from 'vitest';
import { findRoom } from '../../app/navigation';
import { isFeatureLive, isHiddenPath } from '../../app/feature-registry';
import { moreCopy } from './copy';
import { TILES, visibleSections } from './tiles';

const allLive = { hidden: () => false, featureLive: () => true };

describe('More tiles (UI-SPEC 5.11)', () => {
  it('draws Account, Settings, Help, Explore and Protocol in that order, with the spec tiles', () => {
    const groups = visibleSections(allLive);
    expect(groups.map((group) => group.section)).toEqual(['Account', 'Settings', 'Help', 'Explore', 'Protocol']);
    expect(groups.map((group) => group.tiles.map((tile) => tile.id))).toEqual([
      ['account', 'security', 'verification'],
      ['display', 'notifications'],
      ['help'],
      [
        'bank',
        'merchant',
        'academy',
        'agents',
        'quant',
        'launch',
        'market',
        'predict',
        'mining',
        'token',
        'blueprint',
        'campaigns',
        'promotions',
      ],
      ['chain', 'dex', 'protocol'],
    ]);
  });

  it('lists the rooms that used to be hidden, each opening its own page', () => {
    const hrefs = Object.fromEntries(TILES.map((tile) => [tile.id, tile.href]));
    expect(hrefs).toMatchObject({
      bank: '/bank',
      merchant: '/pay/merchant',
      academy: '/academy',
      agents: '/agents',
      quant: '/quant',
      launch: '/launch',
      market: '/market',
      predict: '/predict',
      mining: '/mining',
      token: '/token',
      blueprint: '/blueprint',
      campaigns: '/campaigns',
      promotions: '/uc/promotion',
      chain: '/chain',
      dex: '/dex',
      protocol: '/protocol',
    });
  });

  it('marks the three parked Protocol rooms "Parked – view blockers", and keeps their routes parked', () => {
    for (const id of ['chain', 'dex', 'protocol']) {
      const tile = TILES.find((candidate) => candidate.id === id)!;
      expect(moreCopy.t(tile.line)).toBe('Parked – view blockers');
      expect(findRoom(tile.href)?.area).toBe('parked');
    }
  });

  it('drops a tile whose screen is hidden or whose registry feature is not live, and a section left empty', () => {
    const groups = visibleSections({ hidden: (path) => path === '/view' || path === '/chain', featureLive: (id) => id !== 'help-support' });
    expect(groups.map((group) => group.section)).toEqual(['Account', 'Settings', 'Explore', 'Protocol']);
    expect(groups[1]!.tiles.map((tile) => tile.id)).toEqual(['notifications']);
    expect(groups[3]!.tiles.map((tile) => tile.id)).toEqual(['dex', 'protocol']);
  });

  it('every tile opens a real screen: not hidden, not an alias (no redirect), and only parked Protocol tiles leave the shell', () => {
    const shown = visibleSections().flatMap((group) => group.tiles);
    expect(shown.length).toBe(TILES.length);
    for (const tile of shown) {
      const room = findRoom(tile.href);
      expect(room, tile.href).toBeDefined();
      expect(room?.alias, `${tile.href} redirects`).toBeUndefined();
      expect(room?.area, tile.href).not.toBe('public');
      expect(room?.area === 'parked', tile.href).toBe(tile.section === 'Protocol');
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
