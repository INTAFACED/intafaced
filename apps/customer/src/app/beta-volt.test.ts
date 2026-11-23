// The beta shows only rooms finished in Volt (owner decision, 23 Nov 2026): with the beta's list, built from the count as
// vite.config.ts builds it, no door or menu row opens a room volt-count.ts doesn't count; without it, every door and row shows.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { betaHides, betaRoomList, betaRooms } from './beta-volt';
import { isHiddenPath } from './feature-registry';
import { tabSpecs } from './menus';
import { findRoom } from './navigation';
import { voltCount } from './volt-count';

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

afterEach(() => vi.unstubAllGlobals());

describe("the beta's menus", () => {
  it('open only rooms the Volt count counts, with the switch on', () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', betaRoomList(count.rooms));
    const shown = links();
    expect(shown.length).toBeGreaterThan(0);
    const off = shown.filter((href) => {
      const room = findRoom(pathOf(href));
      return !room || state.get(room.path) !== 'volt';
    });
    expect(off).toEqual([]);
    for (const href of ACCOUNT_ROWS) {
      const visible = !isHiddenPath(pathOf(href));
      expect({ href, visible }).toEqual({ href, visible: state.get(href) === 'volt' || findRoom(href)?.area === 'public' });
    }
  });

  it('keep every door and row with the switch off, as on the test stack and in CI', () => {
    expect(betaRooms()).toBeUndefined();
    expect(tabSpecs('simple', true).map((tab) => tab.door)).toEqual(['Home', 'Money', 'Trade', 'Pay', 'More']);
    expect(links().filter((href) => isHiddenPath(pathOf(href)))).toEqual([]);
    expect(ACCOUNT_ROWS.filter((href) => isHiddenPath(href))).toEqual([]);
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

  it('never hides sign-in, the public pages or the merchant portal pages', () => {
    const list = betaRoomList(count.rooms);
    expect(betaHides('/login', list)).toBe(false);
    expect(betaHides('/register', list)).toBe(false);
    expect(list.some(([route]) => route.startsWith('portal:'))).toBe(false);
  });
});
