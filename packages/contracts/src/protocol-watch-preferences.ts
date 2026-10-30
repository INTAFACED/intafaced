/**
 * The account's Web3 lists, kept through the identity preferences door (`preferences.get` / `preferences.set`, compare-and-set
 * on `version`) so they follow the person to every device:
 * - `protocol.token-watchlist`: tokens watched by contract address (D-portfolio-wallet-07). A signed-out visitor keeps the
 *   same list in the browser and is offered to import it on sign-in.
 * - `protocol.address-watches`: chain addresses watched with a tag and a private note (D-explorer-04). Only the account that
 *   wrote a watch can read it; the explorer holds no funds and a watch moves nothing.
 *
 * Both are view records: nothing here is read by an authorisation or a money path. An address is stored in lower case, once
 * per list. The caps are fixed guards against a runaway write, not owner limits.
 */
import { z } from 'zod';

export const TOKEN_WATCHLIST_NAMESPACE = 'protocol.token-watchlist' as const;
export const ADDRESS_WATCHES_NAMESPACE = 'protocol.address-watches' as const;

/** A fixed guard against a runaway write. */
export const PROTOCOL_WATCH_MAX = 500;
export const WATCH_TAG_MAX = 40;
export const WATCH_NOTE_MAX = 280;

const address = z.string().regex(/^0x[0-9a-f]{40}$/, 'lower-case 20-byte hex address');

export const tokenWatchlistValueSchema = z
  .array(address)
  .max(PROTOCOL_WATCH_MAX)
  .refine((list) => new Set(list).size === list.length, 'each token once');
export type TokenWatchlistValue = z.infer<typeof tokenWatchlistValueSchema>;

export const addressWatchSchema = z
  .object({
    address,
    tag: z.string().trim().min(1).max(WATCH_TAG_MAX),
    /** Private to the account that wrote it. Empty means no note. */
    note: z.string().max(WATCH_NOTE_MAX),
  })
  .strict();
export type AddressWatch = z.infer<typeof addressWatchSchema>;

export const addressWatchesValueSchema = z
  .array(addressWatchSchema)
  .max(PROTOCOL_WATCH_MAX)
  .refine((list) => new Set(list.map((watch) => watch.address)).size === list.length, 'each address once');
export type AddressWatchesValue = z.infer<typeof addressWatchesValueSchema>;

export const tokenWatchlistPreferenceSchema = z
  .object({ namespace: z.literal(TOKEN_WATCHLIST_NAMESPACE), version: z.number().int(), value: tokenWatchlistValueSchema.nullable() })
  .strict();
export const addressWatchesPreferenceSchema = z
  .object({ namespace: z.literal(ADDRESS_WATCHES_NAMESPACE), version: z.number().int(), value: addressWatchesValueSchema.nullable() })
  .strict();
export type TokenWatchlistPreference = z.infer<typeof tokenWatchlistPreferenceSchema>;
export type AddressWatchesPreference = z.infer<typeof addressWatchesPreferenceSchema>;

/** Merges a browser-kept token list into the account's, keeping the account's order and adding only addresses it lacks. */
export function mergeTokenWatchlists(account: readonly string[], browser: readonly string[]): TokenWatchlistValue {
  const merged = [...account];
  for (const entry of browser) {
    const key = entry.toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(key) && !merged.includes(key)) merged.push(key);
  }
  return merged;
}

/**
 * Adds or replaces one address's watch. Watching an address again with the same tag and note returns the list unchanged, so
 * a repeated save is a no-op rather than a second entry.
 */
export function upsertAddressWatch(list: readonly AddressWatch[], watch: AddressWatch): AddressWatchesValue {
  const key = watch.address.toLowerCase();
  const next = { ...watch, address: key, tag: watch.tag.trim() };
  const index = list.findIndex((entry) => entry.address === key);
  if (index === -1) return [...list, next];
  return list.map((entry, at) => (at === index ? next : entry));
}

/**
 * The client request id of a write: a business key, never random. One id per (person, namespace, version read, value written),
 * so a retry after a lost reply returns the first stored result.
 */
export function protocolWatchRequestId(
  userId: string,
  namespace: typeof TOKEN_WATCHLIST_NAMESPACE | typeof ADDRESS_WATCHES_NAMESPACE,
  ifVersion: number,
  value: unknown,
): string {
  return `${namespace}:${userId.toLowerCase()}:${ifVersion}:${digest(JSON.stringify(value))}`;
}

/** A short, stable digest (FNV-1a, 64 bits), so the id stays well under the 200 characters the door allows. */
function digest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}
