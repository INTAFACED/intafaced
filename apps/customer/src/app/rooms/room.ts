import type { NavigationCopyKey } from '../navigation-copy';
import type { ScreenId } from '../screen-types';

export type Door = 'Home' | 'Money' | 'Trade' | 'Pay' | 'More';
export type Room = {
  path: string;
  title: NavigationCopyKey;
  description: NavigationCopyKey;
  door?: Door;
  area: Area;
  business?: boolean;
  /**
   * Redirect target (replace). It may carry a query (`/money/activity?tab=orders`) and the
   * same `:param` names as `path` (`/coin/:asset`); see `resolveAlias`.
   */
  alias?: string;
  /** Not offered in search: a parameter route, or a sign-in step. */
  hidden?: boolean;
  /** Redesigned screen that renders this route; rooms without one render their old view inside `.legacy-room`. */
  screen?: ScreenId;
  /**
   * A public room a sign-in returns to. The help centre promises that an answer kept for signed-in readers opens again
   * after sign-in; every other public room (sign-in, sign-up, recovery, the front page) sends a signed-in person home.
   */
  returnAfterSignIn?: true;
};

export type Area = 'public' | 'home' | 'money' | 'trade' | 'pay' | 'more' | 'person' | 'team' | 'web3';
/** A row of one area's file: a row whose `area` is another area's does not type-check there. */
export type RoomIn<A extends Area> = Room & { area: A };

/**
 * One area's rooms. Each area keeps its rows in its own file (`rooms/<area>.ts`) so a journey that adds a room edits
 * that area's file, never one shared table (project-state #2616): `navigation.ts` only joins them, in area order.
 */
export function areaRooms<A extends Area>(_area: A, list: readonly NoInfer<RoomIn<A>>[]): readonly RoomIn<A>[] {
  return list;
}
