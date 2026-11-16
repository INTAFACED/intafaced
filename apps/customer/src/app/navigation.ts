import type { Door, Room } from './rooms/room';
import { publicRooms } from './rooms/public';
import { homeRooms } from './rooms/home';
import { moneyRooms } from './rooms/money';
import { tradeRooms } from './rooms/trade';
import { payRooms } from './rooms/pay';
import { moreRooms } from './rooms/more';
import { personRooms } from './rooms/person';
import { teamRooms } from './rooms/team';
import { web3Rooms } from './rooms/web3';

export type { Door, Room } from './rooms/room';

/**
 * Every room, joined from the area files in `rooms/` in this order (lookup takes the first match, search lists in this
 * order). Add a room to its area's file, never here (project-state issue 2616; `rooms/rooms.test.ts`).
 */
export const rooms: readonly Room[] = [
  ...publicRooms,
  ...homeRooms,
  ...moneyRooms,
  ...tradeRooms,
  ...payRooms,
  ...moreRooms,
  ...personRooms,
  ...teamRooms,
  ...web3Rooms,
];

export function findRoom(path: string): Room | undefined {
  return (
    rooms.find((room) => room.path === path) ??
    rooms.filter((room) => hasPattern(room.path)).find((room) => matchPath(room.path, path) !== undefined)
  );
}

/** `BTC_USDT`, `btc/usdt` and `BTC%2FUSDT` all become `BTC-USDT`, the shape the desk route uses. */
export function normalizePair(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    /* keep the raw segment */
  }
  return decoded.replace(/[_/]/g, '-').toUpperCase();
}
const aliasParameter = /:([A-Za-z][A-Za-z0-9]*)/g;
/**
 * Where an alias row sends `path` (UI-SPEC 3.2), or undefined when `room` is not an alias.
 * `:param` names in `room.alias` are filled from the matching segments of `path`, a query
 * written on the alias wins over the same key in `search`, and every other query key is kept.
 */
export function resolveAlias(room: Room, path: string, search = ''): string | undefined {
  if (!room.alias) return undefined;
  const params = matchPath(room.path, path) ?? {};
  const fill = (text: string, encode: boolean) =>
    text.replace(aliasParameter, (whole, name: string) => {
      const value = params[name];
      if (value === undefined) return whole;
      const shaped = name === 'pair' ? normalizePair(value) : value;
      // A segment placed in a query is one value, whatever characters it carries.
      return encode ? encodeURIComponent(shaped) : shaped;
    });
  const [aliasPath = '/', aliasQuery = ''] = room.alias.split('?');
  const targetPath = fill(aliasPath, false);
  const query = new URLSearchParams(search);
  for (const [key, value] of new URLSearchParams(fill(aliasQuery, true))) query.set(key, value);
  const text = query.toString();
  return text ? `${targetPath}?${text}` : targetPath;
}
export function customerRoomHref(candidate: string | null | undefined): string | undefined {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return undefined;
  try {
    const url = new URL(candidate, 'https://intafaced.invalid');
    const room = findRoom(url.pathname);
    return room && !['team', 'web3'].includes(room.area) ? `${url.pathname}${url.search}` : undefined;
  } catch {
    return undefined;
  }
}
/** Where a sign-in may land: a signed-in room, or a public room marked `returnAfterSignIn`. One rule for every guard. */
export function isSignInDestination(room: Room): boolean {
  return room.area === 'public' ? room.returnAfterSignIn === true : !['team', 'web3'].includes(room.area);
}

export function safeReturnTo(candidate: string | null | undefined): string {
  const href = customerRoomHref(candidate);
  const room = href ? findRoom(href.split('?')[0] ?? '') : undefined;
  if (!href || !room || !isSignInDestination(room)) return '/home';
  const url = new URL(candidate!, 'https://intafaced.invalid');
  return url.origin === 'https://intafaced.invalid' && !url.username && !url.password ? `${href}${url.hash}` : '/home';
}
export function roomTitle(room: Room, locale: UiLocale = currentPreferences().language): string {
  return navigationCopy.forLocale(locale).t(room.title);
}
export function roomDescription(room: Room, locale: UiLocale = currentPreferences().language): string {
  return navigationCopy.forLocale(locale).t(room.description);
}
/** Where a room lives, as search shows it: "Money > Earn". Parked Web3 rooms sit under More; rooms outside every door have no path. */
export function roomPath(room: Room, locale: UiLocale = currentPreferences().language): string | undefined {
  const door = room.door ?? (room.area === 'web3' ? 'More' : undefined);
  return door ? `${doorLabel(door, locale)} > ${roomTitle(room, locale)}` : undefined;
}

export function doorLabel(door: Door, locale: UiLocale = currentPreferences().language): string {
  return navigationCopy.forLocale(locale).t(door);
}
const publicSearchable = new Set([
  '/help',
  '/status',
  '/notice',
  '/lab',
  '/fees',
  '/rulebook',
  '/app',
  '/partner',
  '/developers',
  '/developers/hosts',
]);
/**
 * Pages offered by search: every room you can open. Aliases, detail routes (flagged `hidden`) and the separate Team desk
 * never appear; Web3 rooms do, so a search finds them and shows their blockers. Business rooms wait for Business
 * mode, except the Merchant home, which is how a Personal account finds the merchant set-up.
 */
export function searchRooms(query: string, mode: 'Personal' | 'Business', locale: UiLocale = currentPreferences().language): Room[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return rooms.filter(
    (room) =>
      !room.hidden &&
      !room.alias &&
      room.area !== 'team' &&
      // Public marketing pages are not part of the signed-in app; Help and the public extras customers once could not reach are.
      (room.area !== 'public' || publicSearchable.has(room.path)) &&
      !isHiddenPath(room.path) &&
      (!room.business || mode === 'Business' || room.path === '/pay/merchant') &&
      words.every((word) =>
        `${room.title} ${room.description} ${room.door ?? ''} ${roomTitle(room, locale)} ${roomDescription(room, locale)} ${room.door ? doorLabel(room.door, locale) : ''}`
          .toLowerCase()
          .includes(word),
      ),
  );
}

export const defaultDeskPair = 'BTC-USDT';
/** The pair of a desk path (`/trade/spot/ETH-USDT`, `/exchange/ETH_USDT`), as "ETH/USDT"; null for any other path. */
export function deskPairLabel(path: string): string | null {
  const match = /^\/(?:trade\/spot|exchange)\/([^/]+)$/.exec(path);
  return match ? normalizePair(match[1]!).replace('-', '/') : null;
}
/** The Trade tab: the markets list in Simple, the desk in Pro. A link to a specific page ignores the mode. */
export function tradeTabHref(layoutMode: 'simple' | 'pro', lastPair: string = defaultDeskPair): string {
  return layoutMode === 'pro' ? `/trade/spot/${normalizePair(lastPair)}` : '/trade';
}
/**
 * Where a coin link goes: the coin page in Simple, the desk in Pro. The coin page needs a session, so a signed-out visitor
 * in Simple gets the public Buy card instead of a sign-in wall.
 */
export function coinHref(asset: string, layoutMode: 'simple' | 'pro', symbol?: string | null, signedIn = true): string {
  if (layoutMode === 'pro') return `/trade/spot/${normalizePair(symbol ?? `${asset}-USDT`)}`;
  return signedIn ? `/coin/${encodeURIComponent(asset)}` : `/trade/buy?asset=${encodeURIComponent(asset)}`;
}
export const doors: ReadonlyArray<{ name: Door; path: string }> = [
  { name: 'Home', path: '/home' },
  { name: 'Money', path: '/money' },
  { name: 'Trade', path: '/trade' },
  { name: 'Pay', path: '/pay' },
  { name: 'More', path: '/more' },
];
import { navigationCopy } from './navigation-copy';
import { currentPreferences } from '../shared/preferences';
import type { UiLocale } from '../shared/i18n';
import { isHiddenPath } from './feature-registry';
import { hasPattern, matchPath } from './path-match';
