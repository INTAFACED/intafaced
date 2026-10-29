import { PROTOCOL_WATCH_MAX } from '@intafaced/contracts/protocol-watch-preferences';

/**
 * Browser-kept view settings for the Tokens room: the chosen window and the signed-out watchlist (D-portfolio-wallet-06,
 * -07). Storage can be blocked or throw, so every read and write is guarded and the room works without it.
 */
export const TOKEN_WINDOWS = ['5m', '1h', '6h', '24h'] as const;
export type TokenWindow = (typeof TOKEN_WINDOWS)[number];
export const DEFAULT_WINDOW: TokenWindow = '1h';

const WINDOW_KEY = 'intafaced.tokens.window';
const WATCHLIST_KEY = 'intafaced.tokens.watchlist';

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readWindow(): TokenWindow {
  try {
    const saved = store()?.getItem(WINDOW_KEY);
    return TOKEN_WINDOWS.find((entry) => entry === saved) ?? DEFAULT_WINDOW;
  } catch {
    return DEFAULT_WINDOW;
  }
}

export function saveWindow(value: TokenWindow): void {
  try {
    store()?.setItem(WINDOW_KEY, value);
  } catch {
    // A blocked store keeps the choice for this visit only.
  }
}

/** The watchlist as lower-case addresses, or null when the browser keeps no site data. */
export function readWatchlist(): string[] | null {
  const storage = store();
  if (!storage) return null;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(WATCHLIST_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && /^0x[0-9a-f]{40}$/.test(entry))
      : [];
  } catch {
    return null;
  }
}

/** The watchlist after a change, or why it was not kept: no site data at all, or this one write failed (a full store). */
export type WatchlistWrite = { ok: true; list: string[] } | { ok: false; reason: 'blocked' | 'not_saved' | 'full' };

function writeWatchlist(change: (list: string[]) => string[]): WatchlistWrite {
  const list = readWatchlist();
  const storage = store();
  if (list === null || storage === null) return { ok: false, reason: 'blocked' };
  const next = change(list);
  if (next.length > PROTOCOL_WATCH_MAX) return { ok: false, reason: 'full' };
  try {
    storage.setItem(WATCHLIST_KEY, JSON.stringify(next));
    return { ok: true, list: next };
  } catch {
    return { ok: false, reason: 'not_saved' };
  }
}

/** Adds an address once, by its lower-case form. */
export const addToWatchlist = (address: string): WatchlistWrite =>
  writeWatchlist((list) => (list.includes(address.toLowerCase()) ? list : [...list, address.toLowerCase()]));

/** Takes an address off the list. */
export const removeFromWatchlist = (address: string): WatchlistWrite =>
  writeWatchlist((list) => list.filter((entry) => entry !== address.toLowerCase()));
