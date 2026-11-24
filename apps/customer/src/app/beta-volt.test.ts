// The beta shows only rooms finished in Volt (owner decision, 23 Nov 2026): with the beta's list, built from the count as
// vite.config.ts builds it, no door or menu row opens a room volt-count.ts doesn't count; without it, every door and row shows.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { betaHides, betaRoomList, betaRooms, setBetaAccess } from './beta-volt';
import { betaOffFeatureFor, isHiddenPath } from './feature-registry';
import { tabSpecs } from './menus';
import { findRoom, rooms } from './navigation';
import { voltCount } from './volt-count';
import { shownBankRooms } from '../features/money/bank-frame/bank-rooms';

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
