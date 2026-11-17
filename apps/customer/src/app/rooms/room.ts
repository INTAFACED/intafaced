import type { NavigationCopyKey, SharedNavigationCopyKey } from '../navigation-copy';
import type { UiLocale } from '../../shared/locale';
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
 * that area's file, never one shared table (project-state issue 2616): `navigation.ts` only joins them, in area order.
 */
export function areaRooms<A extends Area, const T extends Record<string, string>>(
  _area: A,
  _copy: AreaCopy<T>,
  list: readonly NoInfer<RoomIn<A> & Labelled<(keyof T & string) | SharedNavigationCopyKey>>[],
): readonly RoomIn<A>[] {
  return list;
}

/**
 * One area's room labels: English, and each other language as written (a key left out falls back to English). A row's
 * title and description must be a key of its own area's copy or a shared one (`areaRooms`), so a journey that adds a
 * room writes its labels in that area's file, beside the row, never in ../navigation-copy.ts (project-state issue 2617).
 * A label a second area needs moves to `sharedNavigationCopy` there.
 */
export type AreaCopy<T extends Record<string, string>> = { readonly en: T } & {
  readonly [L in Exclude<UiLocale, 'en'>]?: Partial<Record<keyof T, string>>;
};
type Labelled<K> = { title: K; description: K };
export function areaCopy<const T extends Record<string, string>>(copy: AreaCopy<T>): AreaCopy<T> {
  return copy;
}
