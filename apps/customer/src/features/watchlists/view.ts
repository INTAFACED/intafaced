/**
 * How a person arranges a watchlist on this device: the sort and the column widths. These are display choices only, kept in this
 * browser (never on the account, never a money input). A blocked or missing store means the defaults, with no error.
 */
import { WATCHLIST_COLUMNS, type SortState, type WatchlistColumn } from './model';

export interface WatchlistView {
  sort: SortState | null;
  widths: Partial<Record<WatchlistColumn, number>>;
}

export const DEFAULT_VIEW: WatchlistView = { sort: null, widths: {} };
export const MIN_WIDTH = 64;
export const MAX_WIDTH = 480;

const key = (userId: string | null) => `intafaced.customer.watchlists.view.v1:${userId ?? 'guest'}`;

export function readWatchlistView(userId: string | null, storage: Pick<Storage, 'getItem'> | null = safeStorage()): WatchlistView {
  try {
    const raw = storage?.getItem(key(userId));
    if (!raw) return DEFAULT_VIEW;
    const parsed = JSON.parse(raw) as Partial<WatchlistView>;
    const sort =
      parsed.sort &&
      (WATCHLIST_COLUMNS as readonly string[]).includes(parsed.sort.column) &&
      ['asc', 'desc'].includes(parsed.sort.direction)
        ? parsed.sort
        : null;
    const widths: WatchlistView['widths'] = {};
    for (const column of WATCHLIST_COLUMNS) {
      const width = parsed.widths?.[column];
      if (typeof width === 'number' && width >= MIN_WIDTH && width <= MAX_WIDTH) widths[column] = Math.round(width);
    }
    return { sort, widths };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function writeWatchlistView(
  userId: string | null,
  view: WatchlistView,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  try {
    storage?.setItem(key(userId), JSON.stringify(view));
  } catch {
    /* The arrangement lasts for this tab only. */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
