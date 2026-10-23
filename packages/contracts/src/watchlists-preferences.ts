/**
 * The account-level watchlists (`trade.watchlists`) and saved screens (`trade.screens`), C-alerts-scan-05 and -07. Both are
 * view records a person keeps on the account so a second device shows the same lists and screens. They are view settings
 * only: a list never places an order, and a screen never changes a market, a price or a balance.
 *
 * Stored through the identity preferences door (`preferences.get` / `preferences.set`, compare-and-set on `version`). The
 * owner's caps (named lists per account, symbols per list, saved screens) are checked by identity against its own settings;
 * a blank cap refuses the write, never a default. Symbols here are only checked for shape; the customer checks each one
 * against the listing before it is added.
 */
import { z } from 'zod';

export const WATCHLISTS_NAMESPACE = 'trade.watchlists' as const;
export const SAVED_SCREENS_NAMESPACE = 'trade.screens' as const;

/** Colour flags a named list may carry. */
export const WATCHLIST_FLAGS = ['red', 'amber', 'green', 'blue'] as const;
/** Columns a saved screen may show. */
export const SCREEN_COLUMNS = ['last', 'change', 'volume', 'high', 'low'] as const;
/** The timeframe the change column measures over. `4h` is not served by the candle read, so a screen may keep it and show 'not served'. */
export const SCREEN_TIMEFRAMES = ['24h', '4h', '1h', '1d'] as const;

/** A fixed guard against a runaway write, whatever the owner's per-list cap is. */
export const WATCHLIST_HARD_SYMBOL_MAX = 1000;
export const WATCHLIST_MAX_LISTS = 20;
export const WATCHLIST_MAX_SECTIONS = 10;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'id');
const symbol = z.string().regex(/^[A-Za-z0-9._-]{1,32}\/[A-Za-z0-9._:-]{1,32}$/, 'symbol');
const decimalText = z.string().regex(/^-?\d{1,18}(\.\d{1,18})?$/, 'decimal');

export const watchlistSectionSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(40),
    collapsed: z.boolean(),
    symbols: z.array(symbol).max(WATCHLIST_HARD_SYMBOL_MAX),
  })
  .strict()
  .refine((section) => new Set(section.symbols).size === section.symbols.length, 'each symbol once in a section');

export const watchlistSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(40),
    flag: z.enum(WATCHLIST_FLAGS).nullable(),
    sections: z.array(watchlistSectionSchema).min(1).max(WATCHLIST_MAX_SECTIONS),
  })
  .strict()
  .refine((list) => {
    const all = list.sections.flatMap((section) => section.symbols);
    return new Set(all).size === all.length;
  }, 'each symbol once in a list');

export const watchlistsValueSchema = z
  .array(watchlistSchema)
  .max(WATCHLIST_MAX_LISTS)
  .refine((lists) => new Set(lists.map((list) => list.id)).size === lists.length, 'each list id once');
export type WatchlistsValue = z.infer<typeof watchlistsValueSchema>;
export type WatchlistValue = z.infer<typeof watchlistSchema>;

export const watchlistsPreferenceSchema = z
  .object({ namespace: z.literal(WATCHLISTS_NAMESPACE), version: z.number().int(), value: watchlistsValueSchema.nullable() })
  .strict();
export type WatchlistsPreference = z.infer<typeof watchlistsPreferenceSchema>;

/** A saved screen: its filters (a blank bound is null, never a default), its columns and the timeframe the change column uses. */
export const savedScreenFiltersSchema = z
  .object({
    quote: z.string().trim().max(12).nullable(),
    changeMin: decimalText.nullable(),
    changeMax: decimalText.nullable(),
    volumeMin: decimalText.nullable(),
    lastMin: decimalText.nullable(),
    lastMax: decimalText.nullable(),
    /** `all` screens every listed market; `list` screens one watchlist only. */
    universe: z.enum(['all', 'list']),
    listId: id.nullable(),
  })
  .strict();
export const savedScreenSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(60),
    filters: savedScreenFiltersSchema,
    columns: z.array(z.enum(SCREEN_COLUMNS)).max(SCREEN_COLUMNS.length),
    changeTimeframe: z.enum(SCREEN_TIMEFRAMES),
  })
  .strict();
export const savedScreensValueSchema = z
  .array(savedScreenSchema)
  .max(50)
  .refine(
    (screens: Array<z.infer<typeof savedScreenSchema>>) => new Set(screens.map((screen) => screen.id)).size === screens.length,
    'each screen id once',
  );
export type SavedScreensValue = z.infer<typeof savedScreensValueSchema>;
export type SavedScreen = z.infer<typeof savedScreenSchema>;

export const savedScreensPreferenceSchema = z
  .object({ namespace: z.literal(SAVED_SCREENS_NAMESPACE), version: z.number().int(), value: savedScreensValueSchema.nullable() })
  .strict();
export type SavedScreensPreference = z.infer<typeof savedScreensPreferenceSchema>;

/** A 64-bit FNV-1a digest of a text, as hex, so a business key stays short. */
export function recordDigest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * The client request id of a write: a business key, never random. One id per (person, version read, record written), so a
 * retry after a lost reply returns the first stored result, while another device's different write at the same version meets
 * a version conflict instead.
 */
export function watchlistsRequestId(userId: string, ifVersion: number, value: WatchlistsValue): string {
  return `watchlists:${userId.toLowerCase()}:${ifVersion}:${recordDigest(JSON.stringify(value))}`;
}
export function savedScreensRequestId(userId: string, ifVersion: number, value: SavedScreensValue): string {
  return `saved-screens:${userId.toLowerCase()}:${ifVersion}:${recordDigest(JSON.stringify(value))}`;
}
