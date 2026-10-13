/**
 * Favourite markets, kept on this device.
 *
 * Same storage key as the existing trade screen (`trade-favorites:<userId>`,
 * `guest` when signed out) so favourites people already saved survive the
 * redesign. The value is a JSON array of market symbols such as "BTC/USDT".
 * Storage can be missing or throw (private window, blocked site data); every
 * read and write is wrapped and the list then lives in memory for the tab.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';

export const FAVORITES_KEY_PREFIX = 'trade-favorites:';
export const GUEST = 'guest';

export function favoritesKey(userId: string | null | undefined): string {
  return `${FAVORITES_KEY_PREFIX}${userId ?? GUEST}`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Keep only symbol strings, drop blanks and repeats, preserve order. */
export function cleanFavorites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const symbol = item.trim();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}

/** Tab-local copy used when storage is blocked, keyed like storage. */
const memory = new Map<string, string[]>();
const listeners = new Set<() => void>();
/** Stable snapshots per key so useSyncExternalStore does not loop. */
const snapshots = new Map<string, readonly string[]>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function readFavorites(userId: string | null | undefined, storage: StorageLike | null = defaultStorage()): string[] {
  const key = favoritesKey(userId);
  try {
    const raw = storage?.getItem(key);
    if (raw !== null && raw !== undefined) return cleanFavorites(JSON.parse(raw));
  } catch {
    /* fall through to the in-tab copy */
  }
  return [...(memory.get(key) ?? [])];
}

export function writeFavorites(
  userId: string | null | undefined,
  symbols: readonly string[],
  storage: StorageLike | null = defaultStorage(),
): void {
  const key = favoritesKey(userId);
  const clean = cleanFavorites(symbols);
  memory.set(key, clean);
  try {
    storage?.setItem(key, JSON.stringify(clean));
  } catch {
    /* favourites stay available in this tab */
  }
  snapshots.delete(key);
  notify();
}

/** Add or remove a symbol; returns the new list. */
export function toggleFavorite(
  userId: string | null | undefined,
  symbol: string,
  storage: StorageLike | null = defaultStorage(),
): string[] {
  const current = readFavorites(userId, storage);
  const next = current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol];
  writeFavorites(userId, next, storage);
  return next;
}

function snapshotFor(userId: string | null | undefined): readonly string[] {
  const key = favoritesKey(userId);
  const cached = snapshots.get(key);
  if (cached) return cached;
  const fresh = readFavorites(userId);
  snapshots.set(key, fresh);
  return fresh;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forget cached snapshots (tests, and the cross-tab `storage` event). */
export function resetFavoritesCache(): void {
  snapshots.clear();
  memory.clear();
  notify();
}

const SERVER_SNAPSHOT: readonly string[] = [];

export interface FavoritesApi {
  favorites: readonly string[];
  isFavorite: (symbol: string) => boolean;
  toggle: (symbol: string) => void;
}

/** Favourites for a user (pass the session's userId, or null when signed out). */
export function useFavorites(userId: string | null | undefined): FavoritesApi {
  const favorites = useSyncExternalStore(
    subscribe,
    () => snapshotFor(userId),
    () => SERVER_SNAPSHOT,
  );
  useEffect(() => {
    // Another tab changed the list.
    const onStorage = (event: StorageEvent) => {
      if (event.key === favoritesKey(userId)) {
        snapshots.delete(favoritesKey(userId));
        notify();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [userId]);
  const toggle = useCallback((symbol: string) => void toggleFavorite(userId, symbol), [userId]);
  return { favorites, isFavorite: (symbol) => favorites.includes(symbol), toggle };
}
