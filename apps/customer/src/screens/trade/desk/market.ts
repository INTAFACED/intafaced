/**
 * The market the desk is on: its rules (tick, lot, minimums, fees) and whether it can be traded now.
 * Money fields stay decimal strings. Nothing here turns a price or amount into a JS number.
 */
import { z } from 'zod';
import { listingSchema } from '../../../features/trade/trade-api';

/** `/markets` row as the desk reads it: the existing trade schema plus the market state the data layer also reads. */
export const deskListingSchema = listingSchema.extend({
  lifecycle: z.object({ state: z.string() }).passthrough().nullish(),
});
export type DeskListing = z.infer<typeof deskListingSchema>;

export interface DeskMarket {
  symbol: string;
  base: string;
  quote: string;
  /** Smallest price step. Prices must be a whole multiple of it. */
  tickSize: string;
  /** Smallest amount step. Amounts must be a whole multiple of it. */
  lotSize: string;
  minAmount: string | null;
  /** Smallest order value in the quote asset. */
  minCost: string | null;
  /** Can be traded right now (listed, orderable, session open, state OPEN). */
  open: boolean;
  /** The listed lifecycle state (OPEN, POST_ONLY, HALTED ...), or null when the listing names none. */
  state: string | null;
}

export function toDeskMarket(listing: DeskListing): DeskMarket {
  const stateOpen = listing.lifecycle ? listing.lifecycle.state === 'OPEN' : true;
  return {
    symbol: listing.symbol,
    base: listing.base,
    quote: listing.quote,
    tickSize: listing.precision.price,
    lotSize: listing.precision.amount,
    minAmount: listing.limits.amount.min,
    minCost: listing.limits.cost.min,
    open: listing.orderable && listing.active && listing.sessionOpen && stateOpen,
    state: listing.lifecycle?.state?.trim() || null,
  };
}

export const NAMED_MODES = ['OPEN', 'POST_ONLY', 'LIMIT_ONLY', 'CANCEL_ONLY', 'REDUCE_ONLY', 'HALTED'] as const;
export type NamedMode = (typeof NAMED_MODES)[number];

/** The trading mode the listing states: a named mode, 'other' for a state the desk has no words for (never shown raw), or null when none is listed. */
export function tradingMode(state: string | null): NamedMode | 'other' | null {
  if (state === null) return null;
  return (NAMED_MODES as readonly string[]).includes(state) ? (state as NamedMode) : 'other';
}

/** Real spot markets only (no paper markets). */
export function toDeskMarkets(listings: readonly DeskListing[]): DeskMarket[] {
  return listings.filter((m) => m.spot && !m.paper).map(toDeskMarket);
}

/** "BTC/USDT" -> "BTC-USDT": the shape the desk route uses. */
export const pairOf = (symbol: string): string => symbol.replace('/', '-');

/** The market a route pair names (`BTC-USDT`, any case or separator the router already normalised). */
export function findMarket(markets: readonly DeskMarket[], pair: string): DeskMarket | undefined {
  const wanted = pair.toUpperCase();
  return markets.find((m) => pairOf(m.symbol).toUpperCase() === wanted || m.symbol.toUpperCase() === wanted);
}
