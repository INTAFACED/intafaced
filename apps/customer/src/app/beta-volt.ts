import { hasPattern, matchPath } from './path-match';

/**
 * The beta shows only rooms finished in Volt (owner decision, 23 Nov 2026: "Hide unfinished screens from the beta's
 * menus"). The beta's build (`INTAFACED_BETA_VOLT_ONLY=1`, set by tooling/beta/beta-host.mjs) defines this list from
 * `voltCount()` (volt-count.ts), so a room comes back the moment it counts in Volt; every other build leaves it
 * undefined and hides nothing. Each row is a room's route, in the route table's order, and whether it is in Volt.
 */
export type BetaRooms = readonly (readonly [route: string, volt: boolean])[];
declare const __BETA_VOLT_ROOMS__: BetaRooms | undefined;

/** The areas whose rooms the beta hides when they are not in Volt: sign-in, the public pages and the merchant portal's own pages stay. */
const HIDDEN_AREAS = new Set(['home', 'money', 'trade', 'pay', 'more', 'person', 'web3']);

/** The beta's list from the count's rooms (vite.config.ts calls this at build time). */
export function betaRoomList(rooms: readonly { key: string; area: string; state: string }[]): BetaRooms {
  return rooms.filter((room) => HIDDEN_AREAS.has(room.area)).map((room) => [room.key, room.state === 'volt'] as const);
}

/** The list this build was given, or undefined when the switch is off. */
export function betaRooms(): BetaRooms | undefined {
  return typeof __BETA_VOLT_ROOMS__ === 'undefined' ? undefined : __BETA_VOLT_ROOMS__;
}

/** Whether this build hides `path`: it opens a room the beta's list holds as not in Volt (looked up as `findRoom` does). */
export function betaHides(path: string, list: BetaRooms | undefined = betaRooms()): boolean {
  if (!list) return false;
  const row = list.find(([route]) => route === path) ?? list.find(([route]) => hasPattern(route) && matchPath(route, path) !== undefined);
  return row !== undefined && !row[1];
}
