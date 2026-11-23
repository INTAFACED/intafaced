// The beta's moves in code: with the beta switch on, no button or code-driven move lands on a room the beta hides; it lands
// on the nearest room the beta shows (beta-volt.ts betaShownHref). Links are beta-links.test.ts's.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { betaHides, betaRoomList, betaShownHref, type BetaRooms } from './beta-volt';
import { leaveTo, navigate } from './location';
import { findRoom, rooms } from './navigation';
import { voltCount } from './volt-count';

const list: BetaRooms = betaRoomList(voltCount().rooms, rooms);
const root = join(__dirname, '..');
const files = (readdirSync(root, { recursive: true }) as string[])
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|spec|compare)\.tsx?$/.test(file) && !file.includes('harness'))
  .map((file) => join(root, file));
const at = (file: string, index: number) => `${file.slice(file.indexOf('/src/') + 1)}:${index + 1}`;

/**
 * Every app path written at the start of a navigate() or leaveTo() call: a quoted string, or a template literal's text up
 * to its first `${…}`, which counts as one path segment when it follows a `/` and as the end of the path otherwise.
 */
const targets = files.flatMap((file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      [...line.matchAll(/\b(?:navigate|leaveTo)\(\s*(?:(['"])(\/[^'"]*)\1|`(\/[^`$]*)(\$\{)?)/g)].map((match) => ({
        at: at(file, index),
        href: match[2] ?? (match[4] && match[3]!.endsWith('/') ? `${match[3]}x` : match[3]!),
      })),
    ),
);

let path = '/';
let loaded: string | undefined;
beforeEach(() => {
  path = '/';
  loaded = undefined;
  const move = (_state: unknown, _title: string, to: string) => void (path = to);
  vi.stubGlobal('history', { pushState: move, replaceState: move });
  vi.stubGlobal('window', { dispatchEvent: () => true, scrollTo: () => undefined });
  vi.stubGlobal('PopStateEvent', class {});
  vi.stubGlobal('location', { assign: (to: string) => void (loaded = to) });
});
afterEach(() => vi.unstubAllGlobals());
const roomOf = (href: string) => href.split(/[?#]/)[0]!;

describe("the beta's moves in code", () => {
  it('reads the navigate() targets', () => {
    expect(targets.length).toBeGreaterThan(40);
    // A Web3 Back button goes to /dex, a room the beta can hide.
    expect(targets.some(({ href }) => href === '/dex')).toBe(true);
  });

  it('lands every navigate() and leaveTo() target found in the sources on a room the beta shows', () => {
    vi.stubGlobal('__BETA_VOLT_ROOMS__', list);
    const hidden = targets.filter(({ href }) => betaHides(roomOf(href), list));
    expect(hidden.length, 'the beta hides some targets, so this test exercises the fallback').toBeGreaterThan(0);
    const dead: string[] = [];
    for (const { at, href } of targets) {
      navigate(href);
      if (betaHides(roomOf(path), list) || !findRoom(roomOf(path))) dead.push(`${at} navigate(${href}) -> ${path}`);
      leaveTo(href);
      if (betaHides(roomOf(loaded!), list)) dead.push(`${at} leaveTo(${href}) -> ${loaded}`);
    }
    expect(dead).toEqual([]);
  });

  it('goes to the nearest parent the beta shows, else Home, and keeps a shown target whole', () => {
    const made: BetaRooms = [
      ['/home', true],
      ['/dex', true],
      ['/dex/pools', false],
      ['/dex/pools/:id', false],
      ['/wallet', false],
      ['/wallet/send', false],
    ];
    expect(betaShownHref('/dex/pools/7?tab=a#b', made)).toBe('/dex');
    expect(betaShownHref('/wallet/send', made)).toBe('/home');
    expect(betaShownHref('/dex?x=1#y', made)).toBe('/dex?x=1#y');
    expect(betaShownHref('https://example.com/wallet', made)).toBe('https://example.com/wallet');
    expect(
      betaShownHref('/wallet', [
        ['/home', false],
        ['/wallet', false],
      ]),
    ).toBe('/');
  });

  it('changes nothing with the switch off', () => {
    for (const { href } of targets) {
      expect(betaShownHref(href)).toBe(href);
      navigate(href);
      expect(path).toBe(href);
      leaveTo(href);
      expect(loaded).toBe(href);
    }
  });

  it('moves only through navigate() or leaveTo(), never history.pushState or location.assign directly', () => {
    const found: string[] = [];
    for (const file of files) {
      if (file.endsWith('/app/location.ts') || file.endsWith('/shared/route-watch.ts')) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/(?:\bhistory\.pushState|\blocation\.(?:assign|replace))\(|\blocation\.href\s*=(?!=)/.test(line)) found.push(at(file, index));
        });
    }
    expect(found, 'move with navigate() or leaveTo() (src/app/location.ts), so the beta can turn a hidden room aside').toEqual([]);
  });
});
