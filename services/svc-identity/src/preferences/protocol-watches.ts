/**
 * The account's Web3 lists (`protocol.token-watchlist`, `protocol.address-watches`). The shapes live in
 * `@intafaced/contracts/protocol-watch-preferences` so the customer app and this door check the same record. They are view
 * records only: nothing here is read by an authorisation or a money path, and a watch moves nothing.
 */
import {
  ADDRESS_WATCHES_NAMESPACE,
  addressWatchesValueSchema,
  TOKEN_WATCHLIST_NAMESPACE,
  tokenWatchlistValueSchema,
  type AddressWatchesValue,
  type TokenWatchlistValue,
} from '@intafaced/contracts/protocol-watch-preferences';
import type { ZodType } from 'zod';
import { PREFERENCES_VALUE_INVALID } from './trade-views.js';

export { ADDRESS_WATCHES_NAMESPACE, TOKEN_WATCHLIST_NAMESPACE };
export type { AddressWatchesValue, TokenWatchlistValue };

function strict<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const error = new Error(PREFERENCES_VALUE_INVALID);
    (error as Error & { code: string }).code = PREFERENCES_VALUE_INVALID;
    throw error;
  }
  return parsed.data;
}

/** Strict: a mixed-case or repeated address, or more than the guard allows, is refused, never trimmed or guessed. */
export const parseTokenWatchlist = (value: unknown): TokenWatchlistValue => strict(tokenWatchlistValueSchema, value);
/** Strict: one watch per address, a tag that is not blank, and no field beyond address, tag and note. */
export const parseAddressWatches = (value: unknown): AddressWatchesValue => strict(addressWatchesValueSchema, value);
