// The beta's links: the beta's build draws no `<a>` to a room the beta hides, wherever it is written, because its
// JSX runtime is swapped for beta-links.ts; every other build keeps React's. The rooms drawn whole: render-record/beta-links.compare.tsx.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloneElement, type ReactElement } from 'react';
import * as react from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BetaDroppedLink, betaDropsLink, betaRuntime, type JsxRuntime } from './beta-links';
import { betaHides, betaRoomList, setBetaAccess, type BetaRooms } from './beta-volt';
import { isHiddenPath } from './feature-registry';
import { navigate } from './location';
import { rooms } from './navigation';
import betaScreens from './beta-screens.json';
import { betaJsxSource, betaVolt } from '../../vite.config';

const list: BetaRooms = betaRoomList(betaScreens.rooms, rooms);
const hidden = list.find(([route, on]) => !on && !route.includes(':'))![0];
const shown = list.find(([route, on]) => on && !route.includes(':'))![0];
/** Every room shown, so a feature row, not the list, is what keeps a room out. */
const everyRoom: BetaRooms = betaRoomList(
  rooms.map((room) => room.path),
  rooms,
);
const runtime = betaRuntime<JsxRuntime>(react);
const jsx = runtime.jsx! as typeof react.jsx;

afterEach(() => {
  vi.unstubAllGlobals();
  setBetaAccess({ business: false, venue: false });
});

describe("the beta's JSX runtime", () => {
  it('draws no link to a room the beta hides, with its query or hash, and keeps every other link', () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', list);
    const page = jsx('p', {
      children: [
        jsx('a', { href: `${hidden}?from=home#top`, children: 'gone' }, 'a'),
        jsx('a', { href: shown, children: 'kept' }, 'b'),
        jsx('a', { href: 'https://example.com/trade', children: 'site' }, 'c'),
        jsx('a', { href: '#part', children: 'here' }, 'd'),
      ],
    });
    expect(renderToStaticMarkup(page)).toBe(
      `<p><a href="${shown}">kept</a><a href="https://example.com/trade">site</a><a href="#part">here</a></p>`,
    );
  });

  it("drops a link handed to a component that clones it, as a Button's render prop does", () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', list);
    const link = jsx('a', { href: hidden });
    expect(link.type).toBe(BetaDroppedLink);
    const Button = ({ render }: { render: ReactElement<{ children?: string }> }) => cloneElement(render, { children: 'Receive' });
    expect(renderToStaticMarkup(jsx(Button, { render: link }))).toBe('');
  });

  it('draws no link to an alias row whose room the beta hides (/uc/record, /exchange)', () => {
    const aliases = rooms.filter((room) => room.alias && betaHides(room.alias.split('?')[0]!, list));
    expect(aliases.length).toBeGreaterThan(0);
    expect(aliases.filter((room) => !betaHides(room.path, list)).map((room) => room.path)).toEqual([]);
  });

  it('changes nothing with the switch off', () => {
    expect(jsx('a', { href: hidden, children: 'room' }).type).toBe('a');
  });
});

/**
 * Rooms whose main area only says it is switched off, needs the venue door, or waits for an owner value. Many are
 * in Volt, so only their feature row hides them; the beta's menus, its drawn links and its moves in code all pass them over.
 */
const PARKED = [
  '/uc/trading-permissions',
  '/trade/positions',
  '/pay/scheduled',
  '/pay/scan',
  '/pay/cases',
  '/blueprint',
  '/token',
  '/predict',
  '/uc/withdraw',
  '/bank/statements',
  '/bank/salary',
  '/bank/account',
  '/bank/rules',
  '/bank/ramps',
  '/bank/loans/overdraft',
  '/bank/loans/personal',
  '/bank/loans/schedule',
  '/bank/cards/credit-card',
  '/bank/cards/credit',
  '/bank/business/loan',
  '/trade/account',
  '/trade/staking',
  '/trade/vaults',
  '/trade/news',
  '/trade/calendar',
  '/pay/bills',
  '/market/mine',
  '/uc/innovation/myorders',
  '/partner',
  '/developers/status',
  '/lab',
  '/fees',
  '/rulebook',
  '/support/chat',
  '/market/strategy',
  '/uc/recharge',
  // Rooms whose every action has a standing blocker, and pages whose owner text is unpublished.
  '/chain',
  '/chain/blocks',
  '/protocol',
  '/protocol/rails',
  '/help/mule-policy',
];
const VENUE = ['/uc/trading-permissions', '/trade/positions', '/trade/account', '/trade/staking', '/trade/vaults', '/fees'];

describe("the beta's parked rooms", () => {
  it('are left out of the menus, every drawn link and every move in code, for a personal account without the venue door', () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', everyRoom);
    let at = '';
    vi.stubGlobal('history', { pushState: (_s: unknown, _t: string, to: string) => void (at = to) });
    vi.stubGlobal('window', { dispatchEvent: () => true, scrollTo: () => undefined });
    vi.stubGlobal('PopStateEvent', class {});
    // Their feature row, not the list, keeps them out: every room is shown here.
    expect(PARKED.filter((path) => betaHides(path, everyRoom))).toEqual([]);
    expect(PARKED.filter((path) => !isHiddenPath(path))).toEqual([]);
    expect(PARKED.filter((path) => !betaDropsLink(`${path}?from=room`))).toEqual([]);
    expect(PARKED.filter((path) => jsx('a', { href: path }).type !== BetaDroppedLink)).toEqual([]);
    const landed = PARKED.flatMap((path) => {
      navigate(path);
      return PARKED.includes(at.split(/[?#]/)[0]!) ? [`${path} -> ${at}`] : [];
    });
    expect(landed).toEqual([]);
  });

  it('keeps Official channels (/help/official-channels) in menus, drawn links and navigation (J-identity-13 #1)', () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', everyRoom);
    let at = '';
    vi.stubGlobal('history', { pushState: (_s: unknown, _t: string, to: string) => void (at = to) });
    vi.stubGlobal('window', { dispatchEvent: () => true, scrollTo: () => undefined });
    vi.stubGlobal('PopStateEvent', class {});
    expect(isHiddenPath('/help/official-channels')).toBe(false);
    expect(betaDropsLink('/help/official-channels')).toBe(false);
    expect(jsx('a', { href: '/help/official-channels', children: 'Official channels' }).type).toBe('a');
    navigate('/help/official-channels');
    expect(at).toBe('/help/official-channels');
  });

  it('come back in links once the account has the venue door, and stay in every other build', () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', everyRoom);
    setBetaAccess({ business: false, venue: true, staking: true, vaults: true });
    expect(VENUE.filter((path) => betaDropsLink(path))).toEqual([]);
    // The door on, but a venue that answers neither staking nor vaults (Hyperliquid's test network): those two stay out.
    setBetaAccess({ business: false, venue: true });
    expect(VENUE.filter((path) => betaDropsLink(path))).toEqual(['/trade/staking', '/trade/vaults']);
    vi.unstubAllGlobals();
    setBetaAccess({ business: false, venue: false });
    expect(PARKED.filter((path) => betaDropsLink(path) || isHiddenPath(path))).toEqual([]);
  });
});

describe("the beta's build", () => {
  const plugin = (on: boolean) => betaVolt(on ? { INTAFACED_BETA_VOLT_ONLY: '1' } : {});
  const resolve = (on: boolean, source: string, importer = '/app/src/Room.tsx') =>
    (plugin(on).resolveId as (source: string, importer?: string) => string | null)(source, importer);

  it("gives every module the beta's runtime with the switch on, and React's own with it off", () => {
    for (const source of ['react/jsx-runtime', 'react/jsx-dev-runtime']) {
      const swapped = resolve(true, source);
      expect(swapped).toMatch(/^\0intafaced-beta:/);
      // The beta's runtime itself reaches React's.
      expect(resolve(true, source, swapped!)).toBeNull();
      expect(resolve(false, source)).toBeNull();
    }
    expect(resolve(true, 'react')).toBeNull();
    expect(betaJsxSource('react/jsx-runtime')).toContain('export const jsxs = runtime.jsxs;');
  });
});

/**
 * Every link reaches the runtime only as JSX. These forms would make one past it: React's createElement('a'), an HTML
 * string holding an app link, or a DOM anchor given the path of a room the beta can hide.
 */
describe('every link is drawn as JSX', () => {
  const roots = [join(__dirname, '..'), join(__dirname, '../../../../packages/ui/src')];
  const files = roots.flatMap((root) =>
    (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => /\.tsx?$/.test(file) && !/\.(test|spec|compare)\.tsx?$/.test(file) && !file.includes('harness'))
      .map((file) => join(root, file)),
  );
  const rooms = new Set(list.map(([route]) => route));
  const roomPath = (text: string) => text.split(/[?#$`'"]/)[0]!;

  it('reads the sources', () => expect(files.length).toBeGreaterThan(500));

  it('makes no link outside JSX', () => {
    const found: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const at = `${file.slice(file.indexOf('/src/') + 1)}:${index + 1}`;
          if (/(?<!document\.)createElement\(\s*['"]a['"]/.test(line)) found.push(`${at} React.createElement('a')`);
          if (/['"`][^'"`]*<a\s[^>]*href=\\?["']\//.test(line) && !/^\s*<a\s/.test(line.trim()) && !file.endsWith('.tsx'))
            found.push(`${at} an HTML string with an app link`);
          const dom = /(?<!location)\.(?:href\s*=|setAttribute\(\s*['"]href['"],)\s*['"`](\/[^'"`]*)/.exec(line);
          if (dom && rooms.has(roomPath(dom[1]!))) found.push(`${at} a DOM anchor to ${roomPath(dom[1]!)}`);
        });
    }
    expect(found, 'write the link as JSX <a href>, so the beta can leave it out (src/app/beta-links.ts)').toEqual([]);
  });
});
