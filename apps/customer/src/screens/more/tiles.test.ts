import { describe, expect, it } from 'vitest';
import { findRoom, rooms, type Room } from '../../app/navigation';
import { isFeatureLive, isHiddenPath } from '../../app/feature-registry';
import { moreCopy } from './copy';
import { allServices, TILES, visibleSections } from './tiles';

const allLive = { hidden: () => false, featureLive: () => true };

describe('More tiles (UI-SPEC 5.11, IA-SPEC 1.4)', () => {
  it('draws the sections in IA-SPEC order, with the spec tiles', () => {
    const groups = visibleSections(allLive);
    expect(groups.map((group) => group.section)).toEqual([
      'Learn and build',
      'Markets and assets',
      'Money and pay',
      'Rewards',
      'Web3',
      'Help',
      'Account',
    ]);
    expect(groups.map((group) => group.tiles.map((tile) => tile.id))).toEqual([
      ['academy', 'agents', 'quant', 'blueprint'],
      ['market', 'launch', 'token', 'mining'],
      ['bank', 'merchant', 'p2p'],
      ['promotions', 'campaigns'],
      ['dex', 'chain', 'protocol', 'predict'],
      ['help'],
      ['account', 'security', 'verification', 'display', 'notifications'],
    ]);
  });

  it('lists the rooms that used to be hidden, each opening its own page', () => {
    const hrefs = Object.fromEntries(TILES.map((tile) => [tile.id, tile.href]));
    expect(hrefs).toMatchObject({
      bank: '/bank',
      merchant: '/pay/merchant',
      p2p: '/p2p',
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

  it('shows the three Web3 rooms without a "Parked" line; their pages name the blockers', () => {
    for (const id of ['chain', 'dex', 'protocol']) {
      const tile = TILES.find((candidate) => candidate.id === id)!;
      expect(moreCopy.t(tile.line)).not.toMatch(/parked/i);
      expect(findRoom(tile.href)?.area).toBe('web3');
      expect(findRoom(tile.href)?.description).not.toMatch(/parked|not activated/i);
    }
  });

  it('drops a tile whose screen is hidden or whose registry feature is not live, and a section left empty', () => {
    const groups = visibleSections({
      hidden: (path) => path === '/view' || path === '/uc/promotion' || path === '/campaigns',
      featureLive: (id) => id !== 'help-support',
    });
    expect(groups.map((group) => group.section)).not.toContain('Help');
    expect(groups.map((group) => group.section)).not.toContain('Rewards');
    expect(groups.find((group) => group.section === 'Account')!.tiles.map((tile) => tile.id)).toEqual([
      'account',
      'security',
      'verification',
      'notifications',
    ]);
  });

  it('every tile opens a real screen: not hidden, not an alias (no redirect), and only the Web3 tiles leave the shell', () => {
    const shown = visibleSections().flatMap((group) => group.tiles);
    expect(shown.length).toBe(TILES.length);
    for (const tile of shown) {
      const room = findRoom(tile.href);
      expect(room, tile.href).toBeDefined();
      expect(room?.alias, `${tile.href} redirects`).toBeUndefined();
      expect(room?.area, tile.href).not.toBe('public');
      expect(room?.area === 'web3', tile.href).toBe(['chain', 'dex', 'protocol'].includes(tile.id));
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

describe('All services (generated from the route table)', () => {
  const listed = () => new Set(allServices(allLive).flatMap((group) => group.rooms.map((room) => room.path)));

  it('has an entry for every non-alias, non-parameter, non-founder room, so a new room needs no edit here', () => {
    const expected = rooms
      .filter(
        (room) =>
          !room.alias &&
          !room.hidden &&
          room.area !== 'team' &&
          !/[:*]/.test(room.path) &&
          (!room.business || room.path === '/pay/merchant' || room.path === '/bank/business'),
      )
      .map((room) => room.path);
    expect([...listed()].sort()).toEqual([...new Set(expected)].sort());
  });

  it('lists a room added to the table with no change to the tile list', () => {
    const added: Room = { path: '/zz-new-room', title: 'Markets', description: 'Prices for every market', door: 'Trade', area: 'trade' };
    const groups = allServices(allLive, [...rooms, added]);
    expect(groups.find((group) => group.id === 'Trade')!.rooms.map((room) => room.path)).toContain('/zz-new-room');
  });

  it('puts the Web3 rooms under Web3, every tile of the curated list somewhere in the index, and nothing twice', () => {
    const groups = allServices(allLive);
    expect(groups.find((group) => group.id === 'Web3')!.rooms.map((room) => room.path)).toEqual(['/dex', '/wallet', '/chain', '/protocol']);
    const paths = groups.flatMap((group) => group.rooms.map((room) => room.path));
    expect(new Set(paths).size).toBe(paths.length);
    for (const tile of TILES) expect(paths, tile.href).toContain(tile.href);
  });

  it('leaves out a room whose feature is hidden, and lists the public information pages', () => {
    const groups = allServices({ hidden: (path) => path === '/p2p', featureLive: () => true });
    expect(groups.flatMap((group) => group.rooms.map((room) => room.path))).not.toContain('/p2p');
    expect(groups.find((group) => group.id === 'Information')!.rooms.map((room) => room.path)).toEqual(
      expect.arrayContaining(['/help', '/notice', '/invite']),
    );
  });
});
