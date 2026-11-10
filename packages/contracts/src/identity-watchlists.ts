import { z } from 'zod';
import { watchlistsValueSchema, type WatchlistsValue } from './watchlists-preferences.js';
import type { ServiceName } from './service-keys.js';

/**
 * A person's watchlists, as svc-notify needs them for a watchlist alert (J-charts-desk-09 #7, C-alerts-scan-03): one alert on
 * every market of a named list, and a market added to the list later picked up on the next sweep. Asked by svc-notify and
 * answered by svc-identity, which keeps the account's `trade.watchlists` record. svc-notify never reads identity's tables.
 *
 * ONE QUESTION, NO WRITE. The answer is each list's id, name and symbols (every section's, in order). A view record only: no
 * balance, no order and no authorisation is read from it. The call is a POST to a tRPC mutation, the same shape as
 * `spaces.ownedAccounts`, because the signed body is what the caller proves.
 *
 * A caller that cannot get an answer gets `unavailable` and must say so: an unreachable identity is never read as "the list
 * is empty", so nothing is added and nothing is taken away on a sweep without an answer.
 */

/** The tRPC path on svc-identity's root router. */
export const IDENTITY_WATCHLISTS_PROCEDURE = 'preferences.watchlistsFor' as const;

/** The only service allowed to call it. Passed to `serviceProcedureFor`; the list is enforced under either S2S mode. */
export const IDENTITY_WATCHLISTS_CALLERS: readonly ServiceName[] = ['svc-notify'];

export const identityWatchlistsInputSchema = z
  .object({
    /** The person whose lists are read. */
    userId: z.string().min(1).max(128),
  })
  .strict();
export type IdentityWatchlistsInput = z.infer<typeof identityWatchlistsInputSchema>;

export const identityWatchlistSchema = z
  .object({
    id: z.string().min(1).max(40),
    name: z.string().min(1).max(40),
    /** Every section's symbols, in the order the person keeps them, each once. */
    symbols: z.array(z.string().min(1).max(65)),
  })
  .strict();
export type IdentityWatchlist = z.infer<typeof identityWatchlistSchema>;

export const identityWatchlistsSchema = z.object({ lists: z.array(identityWatchlistSchema) }).strict();
export type IdentityWatchlists = z.infer<typeof identityWatchlistsSchema>;

/** The stored record as the answer names it. A person with no record has no lists. */
export function watchlistsAnswer(value: WatchlistsValue | null): IdentityWatchlists {
  return {
    lists: (value ?? []).map((list) => ({
      id: list.id,
      name: list.name,
      symbols: list.sections.flatMap((section) => section.symbols),
    })),
  };
}

/** A stored value that is not the record's shape answers nothing, never a guess at what it meant. */
export function parseStoredWatchlists(value: unknown): WatchlistsValue | null {
  if (value === null || value === undefined) return null;
  const parsed = watchlistsValueSchema.safeParse(value);
  if (!parsed.success) throw new Error('identity.watchlists_record_invalid');
  return parsed.data;
}

/** What a caller sees: the lists, or no answer. Never an empty list standing in for no answer. */
export type IdentityWatchlistsResult =
  | { readonly state: 'read'; readonly lists: readonly IdentityWatchlist[] }
  | { readonly state: 'unavailable'; readonly code: 'identity.watchlists_unavailable' };

/** The port svc-notify depends on. The HTTP client implements it; tests inject a fake. */
export interface IdentityWatchlistsPort {
  read(input: IdentityWatchlistsInput): Promise<IdentityWatchlistsResult>;
}
