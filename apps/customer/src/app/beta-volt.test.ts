// The beta shows only rooms finished in Volt (owner decision, 23 Nov 2026): with the beta's list, built from the count as
// vite.config.ts builds it, no door or menu row opens a room volt-count.ts doesn't count; without it, every door and row shows.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { betaHides, betaRoomList, betaRooms, setBetaAccess } from './beta-volt';
import { betaOffFeatureFor, isHiddenPath } from './feature-registry';
import { tabSpecs } from './menus';
import { findRoom, rooms, searchRooms } from './navigation';
import { voltCount } from './volt-count';
import { shownBankRooms } from '../features/money/bank-frame/bank-rooms';
import { allServices, visibleSections } from '../screens/more/tiles';

const count = voltCount();
const state = new Map(count.rooms.map((room) => [room.key, room.state]));
const pathOf = (href: string) => href.split(/[?#]/)[0]!;
/** Each link of the top bar and the phone's bottom bar: the doors and every dropdown row, in both modes, signed in and out. */
const links = () =>
  (['simple', 'pro'] as const).flatMap((mode) =>
    [true, false].flatMap((signedIn) => tabSpecs(mode, signedIn).flatMap((tab) => [tab.href, ...tab.items.map((item) => item.href)])),
  );
/** The account menu's rows (AccountMenu.tsx): Settings, Account, Security, Verification, Developers, and opening a business. */
const ACCOUNT_ROWS = ['/view', '/uc/account', '/uc/safe', '/verification', '/developers', '/pay/onboarding'];

afterEach(() => {
  vi.unstubAllGlobals();
  setBetaAccess({ business: false, venue: false });
});

describe("the beta's menus", () => {
  it('open only rooms the Volt count counts, with the switch on', () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaRoomList(count.rooms, rooms));
    const shown = links();
    expect(shown.length).toBeGreaterThan(0);
    const off = shown.filter((href) => {
      const room = findRoom(pathOf(href));
      return !room || state.get(room.path) !== 'volt';
    });
    expect(off).toEqual([]);
    for (const href of ACCOUNT_ROWS) {
      const visible = !isHiddenPath(pathOf(href));
      const open = (state.get(href) === 'volt' || findRoom(href)?.area === 'public') && !betaOffFeatureFor(href);
      expect({ href, visible }).toEqual({ href, visible: open });
    }
  });

  it("keep Trade's Orders row, whose room (/money/activity) counts in Volt (#10708)", () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaRoomList(count.rooms, rooms));
    expect(state.get('/money/activity')).toBe('volt');
    for (const mode of ['simple', 'pro'] as const) {
      const trade = tabSpecs(mode, true).find((tab) => tab.door === 'Trade');
      expect(trade?.items.map((item) => item.href)).toContain('/money/activity?tab=orders');
    }
    expect(betaHides('/money/activity')).toBe(false);
  });

  it('shows Futures (/trade/futures) in Trade menus, More > All services, search and contract addresses in the beta (#10700)', () => {
    const betaList = betaRoomList(count.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    expect(state.get('/trade/futures')).toBe('volt');
    expect(betaHides('/trade/futures', betaList)).toBe(false);
    expect(betaHides('/trade/futures/BTC-PERP', betaList)).toBe(false);
    for (const mode of ['simple', 'pro'] as const) {
      const trade = tabSpecs(mode, true).find((tab) => tab.door === 'Trade');
      expect(
        trade?.items.map((item) => item.href),
        `Trade menu in ${mode} mode`,
      ).toContain('/trade/futures');
    }
    const moreTrade = allServices().find((group) => group.id === 'Trade');
    expect(moreTrade?.rooms.map((room) => room.path)).toContain('/trade/futures');
    expect(searchRooms('perp', 'Personal').map((room) => room.path)).toContain('/trade/futures');
  });

  it('shows Agents (/agents), Connect your assistant (/agents/connect) and own-agent pages (/agents/:agentId) in Volt, More, All services and search on the beta (J-agents-08, J-agents-21)', () => {
    const betaList = betaRoomList(count.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    expect(state.get('/agents')).toBe('volt');
    expect(state.get('/agents/connect')).toBe('volt');
    expect(state.get('/agents/:agentId')).toBe('volt');
    expect(betaHides('/agents', betaList)).toBe(false);
    expect(betaHides('/agents/connect', betaList)).toBe(false);
    expect(betaHides('/agents/7e29890c-6ef9-4155-bb43-403cbfde5c70', betaList)).toBe(false);
    expect(betaOffFeatureFor('/agents')).toBeUndefined();
    expect(betaOffFeatureFor('/agents/connect')).toBeUndefined();
    expect(betaOffFeatureFor('/agents/7e29890c-6ef9-4155-bb43-403cbfde5c70')).toBeUndefined();
    expect(isHiddenPath('/agents')).toBe(false);
    expect(isHiddenPath('/agents/connect')).toBe(false);
    expect(isHiddenPath('/agents/7e29890c-6ef9-4155-bb43-403cbfde5c70')).toBe(false);
    expect(visibleSections().flatMap((group) => group.tiles.map((tile) => tile.href))).toContain('/agents');
    expect(allServices().flatMap((group) => group.rooms.map((room) => room.path))).toContain('/agents');
    expect(searchRooms('agents', 'Personal').map((room) => room.path)).toContain('/agents');
  });

  it('shows Add money (/bank/ramps/new), Supported assets (/uc/assets) and Balance entries (/money/balance/:asset) on the beta (J-wallet-01)', () => {
    const betaList = betaRoomList(count.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    for (const [route, sample] of [
      ['/bank/ramps/new', '/bank/ramps/new'],
      ['/uc/assets', '/uc/assets'],
      ['/money/balance/:asset', '/money/balance/USDT'],
    ] as const) {
      expect(state.get(route), route).toBe('volt');
      expect(betaHides(sample, betaList), sample).toBe(false);
      expect(isHiddenPath(sample), sample).toBe(false);
    }
  });

  it('shows Activity detail (/money/activity/:id) and Buy and sell (/trade/buy) on the beta (J-portfolio-03 #6 #8)', () => {
    const betaList = betaRoomList(count.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    for (const [route, sample] of [
      ['/money/activity/:id', '/money/activity/tx-1'],
      ['/trade/buy', '/trade/buy'],
    ] as const) {
      expect(state.get(route), route).toBe('volt');
      expect(betaHides(sample, betaList), sample).toBe(false);
      expect(isHiddenPath(sample), sample).toBe(false);
    }
    const simpleTrade = tabSpecs('simple', true).find((tab) => tab.door === 'Trade');
    expect(simpleTrade?.items.map((item) => item.href)).toContain('/trade/buy');
  });

  it('shows Notices (/notice, /notice/:id, /announcement, /announcement/:id) on the beta while keeping Lab, App and Partner blocked (J-cex-spot-10 #10)', () => {
    const betaList = betaRoomList(count.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    for (const [route, sample] of [
      ['/notice', '/notice'],
      ['/notice/:id', '/notice/33333333-3333-4333-8333-333333333333'],
      ['/announcement/:id', '/announcement/33333333-3333-4333-8333-333333333333'],
    ] as const) {
      expect(state.get(route), route).toBe('volt');
      expect(betaHides(sample, betaList), sample).toBe(false);
      expect(betaOffFeatureFor(sample), sample).toBeUndefined();
      expect(isHiddenPath(sample), sample).toBe(false);
    }
    expect(betaHides('/announcement', betaList)).toBe(false);
    expect(betaOffFeatureFor('/announcement')).toBeUndefined();
    expect(isHiddenPath('/announcement')).toBe(false);
    expect(allServices().flatMap((group) => group.rooms.map((room) => room.path))).toContain('/notice');
    expect(searchRooms('notices', 'Personal').map((room) => room.path)).toContain('/notice');
    for (const blockedPath of ['/lab', '/app', '/partner']) {
      expect(betaOffFeatureFor(blockedPath)?.id, blockedPath).toBe('public-extras');
      expect(isHiddenPath(blockedPath), blockedPath).toBe(true);
    }
  });

  it('shows Person-to-person offers (/p2p) and orders (/uc/order) on the beta while keeping the remaining P2P rooms blocked (J-p2p-21)', () => {
    const betaList = betaRoomList(count.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    for (const [route, sample] of [
      ['/p2p', '/p2p'],
      ['/uc/order', '/uc/order'],
    ] as const) {
      expect(state.get(route), route).toBe('volt');
      expect(betaHides(sample, betaList), sample).toBe(false);
      expect(betaOffFeatureFor(sample), sample).toBeUndefined();
      expect(isHiddenPath(sample), sample).toBe(false);
    }
    for (const alias of ['/ctc', '/p2p/orders', '/p2p/orders/trade-1']) {
      expect(betaHides(alias, betaList), alias).toBe(false);
      expect(betaOffFeatureFor(alias), alias).toBeUndefined();
      expect(isHiddenPath(alias), alias).toBe(false);
    }
    for (const mode of ['simple', 'pro'] as const) {
      const pay = tabSpecs(mode, true).find((tab) => tab.door === 'Pay');
      expect(
        pay?.items.map((item) => item.href),
        `Pay menu in ${mode} mode`,
      ).toContain('/p2p');
    }
    expect(visibleSections().flatMap((group) => group.tiles.map((tile) => tile.href))).toContain('/p2p');
    expect(allServices().flatMap((group) => group.rooms.map((room) => room.path))).toContain('/p2p');
    expect(allServices().flatMap((group) => group.rooms.map((room) => room.path))).toContain('/uc/order');
    expect(searchRooms('person-to-person', 'Personal').map((room) => room.path)).toContain('/p2p');
    for (const blockedPath of ['/uc/ad', '/p2p/methods', '/p2p/access', '/chat', '/checkuser']) {
      expect(betaOffFeatureFor(blockedPath)?.id, blockedPath).toBe('p2p');
      expect(isHiddenPath(blockedPath), blockedPath).toBe(true);
    }
  });

  it('keep every door and row with the switch off, as on the test stack and in CI', () => {
    expect(betaRooms()).toBeUndefined();
    expect(tabSpecs('simple', true).map((tab) => tab.door)).toEqual(['Home', 'Money', 'Trade', 'Pay', 'More']);
    expect(links().filter((href) => isHiddenPath(pathOf(href)))).toEqual([]);
    expect(ACCOUNT_ROWS.filter((href) => isHiddenPath(href))).toEqual([]);
    // Switched-off, venue and business rooms all stay too, for any account.
    expect(['/pay/scheduled', '/trade/news', '/trade/positions', '/pay/team', '/pay/merchant'].filter(isHiddenPath)).toEqual([]);
  });

  it('a door whose own room is hidden opens its first shown row, and one with none is dropped', () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', [
      ['/pay', false],
      ['/pay/send', false],
      ['/pay/receive', true],
      ['/trade', false],
      ['/trade/spot/:pair', false],
      ['/trade/buy', false],
      ['/trade/convert', false],
      ['/trade/margin', false],
      ['/trade/futures', false],
      ['/trade/options', false],
      ['/trade/copy', false],
      ['/trade/bots', false],
      ['/otc', false],
      ['/execution', false],
      ['/quant', false],
      ['/quant/editor', false],
      ['/money/activity', false],
    ]);
    const tabs = tabSpecs('simple', true);
    expect(tabs.find((tab) => tab.door === 'Trade')).toBeUndefined();
    const pay = tabs.find((tab) => tab.door === 'Pay')!;
    expect(pay.href).toBe('/pay/receive');
    expect(pay.items.map((item) => item.href)).not.toContain('/pay/send');
  });
});

describe("the beta's menus, by what the build switches on and the account can use (#10300, #10301)", () => {
  const on = () => vi.stubGlobal('__BETA_VOLT_ROOMS__', betaRoomList(count.rooms, rooms));

  it('leave out a room in Volt whose feature this build switches off (#10300: Scheduled payments, News)', () => {
    on();
    expect(state.get('/pay/scheduled')).toBe('volt');
    expect(isHiddenPath('/pay/scheduled')).toBe(true);
    expect(isHiddenPath('/trade/news')).toBe(true);
    expect(betaOffFeatureFor('/pay/scheduled')?.status).toBe('blocked');
  });

  it('leave out the venue rooms while the venue door is off, and bring them back when it is on (#10300: Positions)', () => {
    on();
    expect(state.get('/trade/positions')).toBe('volt');
    expect(isHiddenPath('/trade/positions')).toBe(true);
    setBetaAccess({ business: false, venue: true });
    expect(isHiddenPath('/trade/positions')).toBe(false);
  });

  it("leave out Staking and Vaults while the venue offers neither, though the door is on (#10633: Hyperliquid's test network)", () => {
    on();
    expect(state.get('/trade/staking')).toBe('volt');
    expect(state.get('/trade/vaults')).toBe('volt');
    setBetaAccess({ venue: true });
    expect(isHiddenPath('/trade/positions')).toBe(false);
    expect(isHiddenPath('/trade/staking')).toBe(true);
    expect(isHiddenPath('/trade/vaults')).toBe(true);
    expect(
      links()
        .map(pathOf)
        .filter((path) => path === '/trade/staking' || path === '/trade/vaults'),
    ).toEqual([]);
    setBetaAccess({ venue: true, staking: true });
    expect(isHiddenPath('/trade/staking')).toBe(false);
    expect(isHiddenPath('/trade/vaults')).toBe(true);
  });

  it('give a personal account no business room, and a business account its rooms in Volt (#10301: Team and roles)', () => {
    on();
    expect(state.get('/pay/team')).toBe('volt');
    const businessRows = () => links().filter((href) => betaOffFeatureFor(pathOf(href))?.needs === 'business');
    expect(isHiddenPath('/pay/team')).toBe(true);
    expect(isHiddenPath('/pay/merchant')).toBe(true);
    expect(links().map(pathOf)).not.toContain('/pay/merchant');
    expect(businessRows()).toEqual([]);
    setBetaAccess({ business: true, venue: false });
    expect(isHiddenPath('/pay/team')).toBe(false);
  });

  it("leave a switched-off room out of the Bank's own tabs, except the one open (#10300: Cash and crypto)", () => {
    expect(shownBankRooms()).toContain('Ramps');
    on();
    expect(shownBankRooms()).not.toContain('Ramps');
    expect(shownBankRooms('Ramps')).toContain('Ramps');
  });

  it('never treat opening a business account as a business room', () => {
    on();
    expect(betaOffFeatureFor('/pay/onboarding')).toBeUndefined();
  });
});

describe('betaHides', () => {
  it('looks a path up as findRoom does: an exact route first, then the first pattern', () => {
    const list = [
      ['/coin/:asset', false],
      ['/coin/btc', true],
    ] as const;
    expect(betaHides('/coin/btc', list)).toBe(false);
    expect(betaHides('/coin/eth', list)).toBe(true);
    expect(betaHides('/not-a-room', list)).toBe(false);
    expect(betaHides('/coin/eth', undefined)).toBe(false);
  });

  it("shows a futures contract's address exactly when the futures desk is shown", () => {
    const desk = (state: string) => betaRoomList([{ key: '/trade/futures', area: 'trade', state }], rooms);
    expect(betaHides('/trade/futures/BTC-PERP', desk('volt'))).toBe(false);
    expect(betaHides('/trade/futures/BTC-PERP', desk('not-migrated'))).toBe(true);
  });

  it('never hides sign-in, the public pages or the merchant portal pages', () => {
    const list = betaRoomList(count.rooms, rooms);
    expect(betaHides('/login', list)).toBe(false);
    expect(betaHides('/register', list)).toBe(false);
    expect(list.some(([route]) => route.startsWith('portal:'))).toBe(false);
  });
});
