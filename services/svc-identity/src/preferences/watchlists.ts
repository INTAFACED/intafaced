/**
 * The account's watchlists (`trade.watchlists`) and saved screens (`trade.screens`), C-alerts-scan-05 and -07. The shapes live
 * in `@intafaced/contracts/watchlists-preferences`; this file checks them and the owner's caps. A cap the owner has not set
 * is blank, and a blank cap refuses growth that needs it: nothing here invents a limit.
 * The caps apply to growth only, measured against the stored record: a write that does not raise a count (a delete, a reorder,
 * a rename) always passes, even when the record is already over a cap the owner has since lowered.
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

/** The shape alone, no caps: a value that is not the shape is refused as invalid. */
export function parseWatchlistsShape(value: unknown): WatchlistsValue {
  const parsed = watchlistsValueSchema.safeParse(value);
  if (!parsed.success) refuse(PREFERENCES_VALUE_INVALID);
  return parsed.data;
}

/** The shape alone, no caps, for saved screens. */
export function parseSavedScreensShape(value: unknown): SavedScreensValue {
  const parsed = savedScreensValueSchema.safeParse(value);
  if (!parsed.success) refuse(PREFERENCES_VALUE_INVALID);
  return parsed.data;
}

function symbolCount(list: WatchlistsValue[number] | undefined): number {
  return list ? list.sections.reduce((count, section) => count + section.symbols.length, 0) : 0;
}

/**
 * Refuses a write that grows a count past its cap. Growth is measured against `stored`: the number of lists, of symbols in each
 * list (a list new to the record counts from zero), and of saved screens. A count that does not rise is never refused.
 */
export function checkWatchlistGrowth(next: WatchlistsValue, stored: WatchlistsValue | null, caps: WatchlistCaps): void {
  const before = stored ?? [];
  if (next.length > before.length) {
    if (caps.listCap === null) refuse(WATCHLIST_LIST_CAP_UNSET);
    if (next.length > caps.listCap) refuse(WATCHLIST_CAP_EXCEEDED);
  }
  for (const list of next) {
    const grew = symbolCount(list) - symbolCount(before.find((item) => item.id === list.id));
    if (grew <= 0) continue;
    if (caps.symbolCap === null) refuse(WATCHLIST_SYMBOL_CAP_UNSET);
    if (symbolCount(list) > caps.symbolCap) refuse(WATCHLIST_CAP_EXCEEDED);
  }
}

/** Growth of the saved-screen count is capped; a delete or a rename is not. */
export function checkSavedScreenGrowth(next: SavedScreensValue, stored: SavedScreensValue | null, caps: WatchlistCaps): void {
  const before = stored?.length ?? 0;
  if (next.length <= before) return;
  if (caps.savedScreenCap === null) refuse(SAVED_SCREEN_CAP_UNSET);
  if (next.length > caps.savedScreenCap) refuse(SAVED_SCREEN_CAP_EXCEEDED);
}

/** Shape, then the caps against the stored record (`stored` null when none is stored). Refusals carry their identity code. */
export function parseWatchlists(
  value: unknown,
  caps: WatchlistCaps = NO_WATCHLIST_CAPS,
  stored: WatchlistsValue | null = null,
): WatchlistsValue {
  const lists = parseWatchlistsShape(value);
  checkWatchlistGrowth(lists, stored, caps);
  return lists;
}

/** Shape, then the saved-screen cap against the stored record. */
export function parseSavedScreens(
  value: unknown,
  caps: WatchlistCaps = NO_WATCHLIST_CAPS,
  stored: SavedScreensValue | null = null,
): SavedScreensValue {
  const screens = parseSavedScreensShape(value);
  checkSavedScreenGrowth(screens, stored, caps);
  return screens;
}
