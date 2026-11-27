// The beta shows only Order 1's screens: with the beta's list, built from beta-screens.json as
// vite.config.ts builds it, no door or menu row opens a room no Order 1 step showed; without it, every door and row shows.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { betaHides, betaRoomList, betaRooms, setBetaAccess } from './beta-volt';
import { betaOffFeatureFor, isHiddenPath } from './feature-registry';
import { tabSpecs } from './menus';
import { findRoom, rooms, searchRooms } from './navigation';
import betaScreens from './beta-screens.json';
// @ts-expect-error: a plain .mjs script with no type declarations
import { CATALOGUE_WALKS, orderOneScreens, roomsOf } from '../../scripts/beta-screens.mjs';
import { shownBankRooms } from '../features/money/bank-frame/bank-rooms';
import { allServices, visibleSections } from '../screens/more/tiles';

const shownRooms = new Set(betaScreens.rooms);
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
  it('open only rooms an Order 1 step showed, with the switch on', () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaRoomList(betaScreens.rooms, rooms));
    const shown = links();
    expect(shown.length).toBeGreaterThan(0);
    const off = shown.filter((href) => {
      const room = findRoom(pathOf(href));
      return !room || !shownRooms.has(room.path);
    });
    expect(off).toEqual([]);
    for (const href of ACCOUNT_ROWS) {
      const visible = !isHiddenPath(pathOf(href));
      const open = (shownRooms.has(href) || findRoom(href)?.area === 'public') && !betaOffFeatureFor(href);
      expect({ href, visible }).toEqual({ href, visible: open });
    }
  });

  it("keep Trade's Orders row, whose room (/money/activity) counts in Volt (#10708)", () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaRoomList(betaScreens.rooms, rooms));
    expect(shownRooms.has('/money/activity')).toBe(true);
    for (const mode of ['simple', 'pro'] as const) {
      const trade = tabSpecs(mode, true).find((tab) => tab.door === 'Trade');
      expect(trade?.items.map((item) => item.href)).toContain('/money/activity?tab=orders');
    }
    expect(betaHides('/money/activity')).toBe(false);
  });

  it('shows Futures (/trade/futures) in Trade menus, More > All services, search and contract addresses in the beta (#10700)', () => {
    const betaList = betaRoomList(betaScreens.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    expect(shownRooms.has('/trade/futures')).toBe(true);
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
    const betaList = betaRoomList(betaScreens.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    expect(shownRooms.has('/agents')).toBe(true);
    expect(shownRooms.has('/agents/connect')).toBe(true);
    expect(shownRooms.has('/agents/:agentId')).toBe(true);
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
    const betaList = betaRoomList(betaScreens.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    for (const [route, sample] of [
      ['/bank/ramps/new', '/bank/ramps/new'],
      ['/uc/assets', '/uc/assets'],
      ['/money/balance/:asset', '/money/balance/USDT'],
    ] as const) {
      expect(shownRooms.has(route), route).toBe(true);
      expect(betaHides(sample, betaList), sample).toBe(false);
      expect(isHiddenPath(sample), sample).toBe(false);
    }
  });

  it('shows Activity detail (/money/activity/:id) and Buy and sell (/trade/buy) on the beta (J-portfolio-03 #6 #8)', () => {
    const betaList = betaRoomList(betaScreens.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    for (const [route, sample] of [
      ['/money/activity/:id', '/money/activity/tx-1'],
      ['/trade/buy', '/trade/buy'],
    ] as const) {
      expect(shownRooms.has(route), route).toBe(true);
      expect(betaHides(sample, betaList), sample).toBe(false);
      expect(isHiddenPath(sample), sample).toBe(false);
    }
    const simpleTrade = tabSpecs('simple', true).find((tab) => tab.door === 'Trade');
    expect(simpleTrade?.items.map((item) => item.href)).toContain('/trade/buy');
  });

  it('shows API keys and the API permissions reference (/developers/permissions) on the beta (J-developer-03 #7 #9)', () => {
    const betaList = betaRoomList(betaScreens.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    for (const [route, sample] of [
      ['/uc/safe/api-keys', '/uc/safe/api-keys'],
      ['/uc/safe/api-keys/new', '/uc/safe/api-keys/new'],
      ['/uc/safe/api-keys/:keyId', '/uc/safe/api-keys/0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d'],
      ['/developers/permissions', '/developers/permissions'],
    ] as const) {
      expect(shownRooms.has(route), route).toBe(true);
      expect(betaHides(sample, betaList), sample).toBe(false);
      expect(betaOffFeatureFor(sample), sample).toBeUndefined();
      expect(isHiddenPath(sample), sample).toBe(false);
    }
  });

  it('shows Notices (/notice, /notice/:id, /announcement, /announcement/:id) on the beta while keeping Lab, App and Partner blocked (J-cex-spot-10 #10)', () => {
    const betaList = betaRoomList(betaScreens.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    for (const [, sample] of [
      ['/notice', '/notice'],
      ['/notice/:id', '/notice/33333333-3333-4333-8333-333333333333'],
      ['/announcement/:id', '/announcement/33333333-3333-4333-8333-333333333333'],
    ] as const) {
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
    const betaList = betaRoomList(betaScreens.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    for (const [route, sample] of [
      ['/p2p', '/p2p'],
      ['/uc/order', '/uc/order'],
    ] as const) {
      expect(shownRooms.has(route), route).toBe(true);
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

  it('shows Idempotent order placement (/developers/idempotency) on the beta (J-developer-05 #5)', () => {
    const betaList = betaRoomList(betaScreens.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    expect(shownRooms.has('/developers/idempotency')).toBe(true);
    expect(betaHides('/developers/idempotency', betaList)).toBe(false);
    expect(betaOffFeatureFor('/developers/idempotency')).toBeUndefined();
    expect(isHiddenPath('/developers/idempotency')).toBe(false);
  });

  it('shows the developer portal and the market data downloads on the beta, so J-cex-spot-15 can be proven there (#11177)', () => {
    const betaList = betaRoomList(betaScreens.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    // Every page J-cex-spot-15's steps open (#1 to #4, #6, #7 on /developers, #10 on /trade/markets/downloads), and a
    // section still waiting for its slice (/developers/fix), which shows that slice rather than being hidden.
    for (const path of [
      '/developers',
      '/developers/errors',
      '/developers/errors/auth',
      '/developers/changelog',
      '/developers/bot-policy',
      '/developers/order-types',
      '/developers/rate-limits',
      '/developers/hosts',
      '/developers/status',
      '/developers/fix',
      '/trade/markets/downloads',
    ]) {
      expect(betaHides(path, betaList), path).toBe(false);
      expect(betaOffFeatureFor(path), path).toBeUndefined();
      expect(isHiddenPath(path), path).toBe(false);
    }
    // Registered apps keeps its own blocker (oauth-apps: the token lifetimes are unpublished), so J-cex-spot-15 #1, which
    // opens every section the home page lists, is still named off the beta until that row is live.
    expect(betaOffFeatureFor('/developers/apps')?.id).toBe('oauth-apps');
    expect(isHiddenPath('/developers/apps')).toBe(true);
  });

  it('shows Official channels (/help/official-channels) on the beta while keeping Rulebook, Support chat and Money mule policy blocked (J-identity-13 #1)', () => {
    const betaList = betaRoomList(betaScreens.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    expect(shownRooms.has('/help/official-channels')).toBe(true);
    expect(betaHides('/help/official-channels', betaList)).toBe(false);
    expect(betaOffFeatureFor('/help/official-channels')).toBeUndefined();
    expect(isHiddenPath('/help/official-channels')).toBe(false);
    expect(allServices().flatMap((group) => group.rooms.map((room) => room.path))).toContain('/help/official-channels');
    expect(searchRooms('official channels', 'Personal').map((room) => room.path)).toContain('/help/official-channels');
    for (const blockedPath of ['/rulebook', '/support/chat', '/help/mule-policy']) {
      expect(betaOffFeatureFor(blockedPath)?.id, blockedPath).toBe('owner-blank-pages');
      expect(isHiddenPath(blockedPath), blockedPath).toBe(true);
    }
  });

  it('shows Platform status (/status) on the beta, the page J-cex-spot-14 #2 to #5 open (#11178)', () => {
    const betaList = betaRoomList(betaScreens.rooms, rooms);
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaList);
    expect(shownRooms.has('/status')).toBe(true);
    expect(betaHides('/status', betaList)).toBe(false);
    expect(betaOffFeatureFor('/status')).toBeUndefined();
    expect(isHiddenPath('/status')).toBe(false);
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
  // The switches are judged on rooms the list shows: Order 1's, and the switched rooms themselves.
  const SWITCHED = ['/pay/scheduled', '/trade/news', '/trade/staking', '/trade/vaults', '/pay/team', '/pay/merchant', '/bank/ramps'];
  const on = () => vi.stubGlobal('__BETA_VOLT_ROOMS__', betaRoomList([...betaScreens.rooms, ...SWITCHED], rooms));

  it('leave out a shown room whose feature this build switches off (#10300: Scheduled payments, News)', () => {
    on();
    expect(isHiddenPath('/pay/scheduled')).toBe(true);
    expect(isHiddenPath('/trade/news')).toBe(true);
    expect(betaOffFeatureFor('/pay/scheduled')?.status).toBe('blocked');
  });

  it('leave out the venue rooms while the venue door is off, and bring them back when it is on (#10300: Positions)', () => {
    on();
    expect(shownRooms.has('/trade/positions')).toBe(true);
    expect(isHiddenPath('/trade/positions')).toBe(true);
    setBetaAccess({ business: false, venue: true });
    expect(isHiddenPath('/trade/positions')).toBe(false);
  });

  it("leave out Staking and Vaults while the venue offers neither, though the door is on (#10633: Hyperliquid's test network)", () => {
    on();
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

  it('give a personal account no business room, and a business account its rooms (#10301: Team and roles)', () => {
    on();
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

describe('beta-screens.json, the rooms Order 1 showed (scripts/beta-screens.mjs)', () => {
  it("is made from each Order 1 step's recorded screens, a catalogue walk and other orders left out", () => {
    const shot = (title: string, paths: string[]) => ({
      title,
      tests: [{ annotations: [], results: [{ annotations: [{ type: 'beta screens', description: JSON.stringify(paths) }] }] }],
    });
    const report = {
      suites: [
        {
          specs: [shot('J-a-01 #1 opens the desk', ['/trade/spot/BTC-USDT', '/nowhere'])],
          suites: [{ specs: [shot('J-b-02 #3 later work', ['/academy']), shot('J-home-ia-02 #1 every door', ['/trade/options'])] }],
        },
      ],
    };
    const journeys = [
      { id: 'J-a-01', order: 1 },
      { id: 'J-b-02', order: 2 },
      { id: 'J-home-ia-02', order: 1 },
    ];
    expect(Object.keys(CATALOGUE_WALKS)).toEqual(['J-home-ia-02']);
    const screens = orderOneScreens(report, journeys);
    expect([...screens.keys()]).toEqual(['/trade/spot/BTC-USDT', '/nowhere']);
    expect(roomsOf(screens, findRoom)).toEqual(['/trade/spot/:pair']);
  });

  it('names only rooms of the route table, sorted, home and the desks among them', () => {
    const routes = new Set(rooms.map((room) => room.path));
    expect(betaScreens.rooms.filter((route) => !routes.has(route))).toEqual([]);
    expect([...betaScreens.rooms].sort()).toEqual(betaScreens.rooms);
    for (const route of ['/home', '/trade/spot/:pair', '/trade/futures', '/money', '/wallet']) expect(betaScreens.rooms).toContain(route);
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
    const desk = (shown: boolean) => betaRoomList(shown ? ['/trade/futures'] : [], rooms);
    expect(betaHides('/trade/futures/BTC-PERP', desk(true))).toBe(false);
    expect(betaHides('/trade/futures/BTC-PERP', desk(false))).toBe(true);
  });

  it('never hides sign-in, the public pages or the merchant portal pages', () => {
    const list = betaRoomList(betaScreens.rooms, rooms);
    expect(betaHides('/login', list)).toBe(false);
    expect(betaHides('/register', list)).toBe(false);
    expect(list.some(([route]) => route.startsWith('portal:'))).toBe(false);
  });
});
