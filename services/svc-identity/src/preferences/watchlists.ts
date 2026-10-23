/**
 * The account's watchlists (`trade.watchlists`) and saved screens (`trade.screens`), C-alerts-scan-05 and -07. The shapes live
 * in `@intafaced/contracts/watchlists-preferences`; this file checks them and the owner's caps. A cap the owner has not set
 * is blank, and a blank cap refuses the write that needs it: nothing here invents a limit.
 * A view setting only: nothing here is read by an authorisation or a money path.
 */
import {
  SAVED_SCREENS_NAMESPACE,
  WATCHLISTS_NAMESPACE,
  savedScreensValueSchema,
  watchlistsValueSchema,
  type SavedScreensValue,
  type WatchlistsValue,
} from '@intafaced/contracts/watchlists-preferences';
import { PREFERENCES_VALUE_INVALID } from './trade-views.js';

export { SAVED_SCREENS_NAMESPACE, WATCHLISTS_NAMESPACE };

export const WATCHLIST_LIST_CAP_UNSET = 'identity.watchlist_list_cap_unset' as const;
export const WATCHLIST_SYMBOL_CAP_UNSET = 'identity.watchlist_symbol_cap_unset' as const;
export const WATCHLIST_CAP_EXCEEDED = 'identity.watchlist_cap_exceeded' as const;
export const SAVED_SCREEN_CAP_UNSET = 'identity.saved_screen_cap_unset' as const;
export const SAVED_SCREEN_CAP_EXCEEDED = 'identity.saved_screen_cap_exceeded' as const;

/** The owner's caps: named lists per account, symbols per list, saved screens per account. Null is blank (not set). */
export interface WatchlistCaps {
  readonly listCap: number | null;
  readonly symbolCap: number | null;
  readonly savedScreenCap: number | null;
}
export const NO_WATCHLIST_CAPS: WatchlistCaps = { listCap: null, symbolCap: null, savedScreenCap: null };

function refuse(code: string): never {
  const error = new Error(code);
  (error as Error & { code: string }).code = code;
  throw error;
}

/** Strict shape, then the caps: a list over the per-list cap, or more lists than the list cap, is refused as a whole. */
export function parseWatchlists(value: unknown, caps: WatchlistCaps = NO_WATCHLIST_CAPS): WatchlistsValue {
  const parsed = watchlistsValueSchema.safeParse(value);
  if (!parsed.success) refuse(PREFERENCES_VALUE_INVALID);
  const lists = parsed.data;
  if (lists.length > 0 && caps.listCap === null) refuse(WATCHLIST_LIST_CAP_UNSET);
  if (caps.listCap !== null && lists.length > caps.listCap) refuse(WATCHLIST_CAP_EXCEEDED);
  for (const list of lists) {
    const symbols = list.sections.reduce((count, section) => count + section.symbols.length, 0);
    if (symbols === 0) continue;
    if (caps.symbolCap === null) refuse(WATCHLIST_SYMBOL_CAP_UNSET);
    if (symbols > caps.symbolCap) refuse(WATCHLIST_CAP_EXCEEDED);
  }
  return lists;
}

/** Strict shape, then the saved-screen cap. A screen with no owner cap set is refused, never saved over a guessed limit. */
export function parseSavedScreens(value: unknown, caps: WatchlistCaps = NO_WATCHLIST_CAPS): SavedScreensValue {
  const parsed = savedScreensValueSchema.safeParse(value);
  if (!parsed.success) refuse(PREFERENCES_VALUE_INVALID);
  const screens = parsed.data;
  if (screens.length > 0 && caps.savedScreenCap === null) refuse(SAVED_SCREEN_CAP_UNSET);
  if (caps.savedScreenCap !== null && screens.length > caps.savedScreenCap) refuse(SAVED_SCREEN_CAP_EXCEEDED);
  return screens;
}
