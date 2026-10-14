import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coinHref, customerRoomHref, deskPairLabel, findRoom, resolveAlias, rooms, safeReturnTo, searchRooms } from './navigation';
import { screens } from './screens';
import { isHiddenPath } from './feature-registry';

it('returns a signed-in customer to a requested room, but refuses external and team redirects', () => {
  expect(safeReturnTo('/bank/spaces')).toBe('/bank/spaces');
  expect(safeReturnTo('//example.com')).toBe('/home');
  expect(safeReturnTo('/ops')).toBe('/home');
});

it('preserves the validated authenticated destination query and fragment, including fragment-only links', () => {
  for (const destination of [
    '/blueprint?section=owner#identity-profile',
    '/blueprint#identity-profile',
    '/bank/transfers?tab=history#original',
  ])
    expect(safeReturnTo(destination)).toBe(destination);
});

it('never attaches a refused destination fragment to the fallback or accepts external authority', () => {
  for (const destination of [
    'https://outside.invalid/blueprint#private',
    '//outside.invalid/blueprint#private',
    '/\t/outside.invalid/blueprint#private',
    '/\\outside.invalid/blueprint#private',
    'javascript:alert(1)#private',
    '/login?redirect=%2Fblueprint#private',
    '/register#private',
    '/ops#private',
    '/platform#private',
    '/chain#private',
    '/money/../ops#private',
    '/unknown-room#private',
  ])
    expect(safeReturnTo(destination)).toBe('/home');
});

it('keeps notification href shape and auth return room validation separate', () => {
  expect(customerRoomHref('/blueprint?section=owner#identity-profile')).toBe('/blueprint?section=owner');
  expect(customerRoomHref('/blueprint#identity-profile')).toBe('/blueprint');
  const destination = '/blueprint?next=https%3A%2F%2Foutside.invalid%2F#identity-profile';
  expect(safeReturnTo(destination)).toBe(destination);
});

it('keeps legitimate Money notification links and refuses non-customer destinations', () => {
  expect(customerRoomHref('/money')).toBe('/money');
  expect(customerRoomHref('/portfolio/BTC/repeat-buy')).toBe('/portfolio/BTC/repeat-buy');
  expect(customerRoomHref('/help')).toBe('/help');
  expect(customerRoomHref('/ops')).toBeUndefined();
  expect(customerRoomHref('//external.invalid')).toBeUndefined();
});

it('does not expose merchant, team or parked chain rooms in Personal search', () => {
  expect(searchRooms('', 'Personal').map((room) => room.path)).not.toContain('/pay/merchant');
  expect(searchRooms('chain', 'Personal')).toHaveLength(0);
  expect(searchRooms('operator', 'Personal')).toHaveLength(0);
});

it('finds translated and canonical room labels while preserving customer scope', () => {
  expect(searchRooms('seguridad', 'Personal', 'es').map((room) => room.path)).toContain('/uc/safe');
  expect(searchRooms('security', 'Personal', 'es').map((room) => room.path)).toContain('/uc/safe');
  expect(searchRooms('sécurité', 'Personal', 'fr').map((room) => room.path)).toContain('/uc/safe');
  expect(searchRooms('paiements entreprise', 'Personal', 'fr')).toHaveLength(0);
  expect(searchRooms('operador', 'Personal', 'es')).toHaveLength(0);
  expect(searchRooms('chaîne', 'Personal', 'fr')).toHaveLength(0);
});

it('signed-in sign-in and fallbacks land on /home', () => {
  expect(safeReturnTo(undefined)).toBe('/home');
  expect(safeReturnTo('/')).toBe('/home');
  expect(safeReturnTo('/home')).toBe('/home');
  expect(findRoom('/home')?.screen).toBe('home');
});

it('never offers a hidden feature in search', () => {
  for (const query of ['deposit', 'withdraw', 'bank', 'margin', 'futures', 'person-to-person', 'academy', 'bill pay', 'notices', ''])
    for (const room of searchRooms(query, 'Personal', 'en', false))
      expect(isHiddenPath(room.path, false), `${query}: ${room.path}`).toBe(false);
  expect(searchRooms('deposit', 'Personal', 'en', false)).toHaveLength(0);
  // With Preview on (dev, local stack, staging) the Preview products are searchable; with it off they are not.
  expect(searchRooms('deposit', 'Personal', 'en', true).map((room) => room.path)).toContain('/uc/recharge');
  expect(searchRooms('academy', 'Personal')).toHaveLength(0);
  expect(searchRooms('activity', 'Personal').map((room) => room.path)).toContain('/money/activity');
  expect(searchRooms('markets', 'Personal').map((room) => room.path)).toContain('/trade');
  const everything = searchRooms('', 'Personal').map((room) => room.path);
  expect(everything).toContain('/help');
  expect(everything).not.toContain('/about-us');
  expect(everything).not.toContain('/invite');
});

describe('resolveAlias (UI-SPEC 3.2)', () => {
  const resolve = (path: string, search = '') => {
    const room = findRoom(path);
    return room ? resolveAlias(room, path, search) : undefined;
  };
  it('fills :param names from the old path and keeps the query', () => {
    expect(resolve('/portfolio/BTC')).toBe('/coin/BTC');
    expect(resolve('/portfolio/BTC', '?from=home')).toBe('/coin/BTC?from=home');
    expect(resolve('/money/asset/ETH', '?a=1&b=2')).toBe('/coin/ETH?a=1&b=2');
  });
  it('normalises the market pair to BASE-QUOTE upper case', () => {
    expect(resolve('/exchange/btc-usdt')).toBe('/trade/spot/BTC-USDT');
    expect(resolve('/exchange/eth_usdc')).toBe('/trade/spot/ETH-USDC');
    expect(resolve('/exchange/BTC%2FUSDT')).toBe('/trade/spot/BTC-USDT');
    expect(resolve('/exchange/btc%2fusdt', '?x=1')).toBe('/trade/spot/BTC-USDT?x=1');
  });
  it('maps the old order and record pages onto Activity tabs', () => {
    expect(resolve('/uc/record')).toBe('/money/activity');
    expect(resolve('/uc/record', '?tab=trades')).toBe('/money/activity?tab=trades');
    expect(resolve('/uc/entrust/current')).toBe('/money/activity?tab=orders');
    expect(resolve('/uc/entrust/history')).toBe('/money/activity?tab=orders&status=closed');
  });
  it('lets the alias own its query keys and keeps the rest', () => {
    expect(resolve('/uc/entrust/current', '?tab=trades&page=2')).toBe('/money/activity?tab=orders&page=2');
  });
  it('keeps a plain alias a plain redirect and ignores rooms that are not aliases', () => {
    expect(resolve('/exchange')).toBe('/trade');
    expect(resolve('/exchange', '?simulated=true')).toBe('/trade?simulated=true');
    expect(resolve('/portfolio')).toBe('/money');
    expect(resolve('/bank')).toBe('/money');
    expect(resolve('/uc/money')).toBe('/money');
    expect(resolve('/money')).toBeUndefined();
    expect(resolve('/coin/BTC')).toBeUndefined();
  });
});

describe('route table', () => {
  const follow = (start: string) => {
    let [path = '/', search = ''] = start.split(/(?=\?)/);
    for (let hop = 0; hop < 4; hop += 1) {
      const room = findRoom(path);
      const next = room ? resolveAlias(room, path, search) : undefined;
      if (!next) return `${path}${search}`;
      [path = '/', search = ''] = next.split(/(?=\?)/);
    }
    throw new Error(`alias chain too long from ${start}`);
  };
  it('keeps every old link working: each one ends on its new place', () => {
    const expected: Array<[string, string]> = [
      ['/index', '/'],
      ['/uc/money', '/money'],
      ['/portfolio', '/money'],
      ['/bank', '/money'],
      ['/portfolio/BTC', '/coin/BTC'],
      ['/money/asset/BTC', '/coin/BTC'],
      ['/uc/record', '/money/activity'],
      ['/uc/entrust/current', '/money/activity?tab=orders'],
      ['/uc/entrust/history', '/money/activity?tab=orders&status=closed'],
      ['/exchange', '/trade'],
      ['/exchange/BTC-USDT', '/trade/spot/BTC-USDT'],
      ['/uc', '/uc/account'],
      ['/uc/trade', '/view'],
      ['/helplist', '/help'],
      ['/reg', '/register'],
    ];
    for (const [from, to] of expected) expect(follow(from), from).toBe(to);
  });
  it('points every alias at a real, non-alias room and only uses :param names its own path has', () => {
    for (const room of rooms.filter((candidate) => candidate.alias)) {
      const target = (room.alias ?? '').split('?')[0] ?? '';
      const destination = findRoom(target.replace(/:[A-Za-z]+/g, 'x'));
      expect(destination, `${room.path} -> ${room.alias}`).toBeDefined();
      expect(destination?.alias, `${room.path} chains through ${destination?.path}`).toBeUndefined();
      const own = new Set((room.path.match(/:[A-Za-z]+/g) ?? []).map((name) => name));
      for (const name of room.alias?.match(/:[A-Za-z]+/g) ?? []) expect(own.has(name), `${room.path} lacks ${name}`).toBe(true);
    }
  });
  it("gives every redesigned screen a registered, existing screen folder (Home is B4's and may not exist yet)", () => {
    const ids = new Set(rooms.flatMap((room) => (room.screen ? [room.screen] : [])));
    expect([...ids].sort()).toEqual(Object.keys(screens).sort());
    for (const id of ids) {
      if (id === 'home') continue;
      expect(existsSync(fileURLToPath(new URL(`../screens/${id}/index.tsx`, import.meta.url))), id).toBe(true);
    }
  });
  it('resolves the new top-level routes to their screens', () => {
    expect(findRoom('/coin/BTC')?.screen).toBe('coin');
    expect(findRoom('/trade/spot/BTC-USDT')?.screen).toBe('trade/desk');
    expect(findRoom('/money/activity')?.screen).toBe('money');
    expect(findRoom('/trade/buy')?.screen).toBe('trade/buy');
    expect(findRoom('/pay/send')?.screen).toBe('pay');
  });
});

it('titles each desk market by its pair, so desk tabs can be told apart', () => {
  expect(deskPairLabel('/trade/spot/ETH-USDT')).toBe('ETH/USDT');
  expect(deskPairLabel('/exchange/eth_usdc')).toBe('ETH/USDC');
  expect(deskPairLabel('/trade/spot/BTC%2FUSDT')).toBe('BTC/USDT');
  expect(deskPairLabel('/trade')).toBeNull();
  expect(deskPairLabel('/trade/spot/BTC-USDT/extra')).toBeNull();
});

it('a coin link needs a session for the coin page, so a signed-out visitor gets the public Buy card instead', () => {
  expect(coinHref('BTC', 'simple')).toBe('/coin/BTC');
  expect(coinHref('BTC', 'simple', null, false)).toBe('/trade/buy?asset=BTC');
  expect(coinHref('BTC', 'pro', 'BTC/USDT', false)).toBe('/trade/spot/BTC-USDT');
});
