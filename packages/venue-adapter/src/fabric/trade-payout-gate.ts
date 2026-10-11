/**
 * venue.aggregation trading half — payout-grade gate before signed place (P-05).
 *
 * MD adapters already refuse dust on snapshotBook. Trade adapters must not
 * bypass that gate when submitting — quote-only is not Done.
 */
import { VenueUnavailableError, type VenueBookSnapshot } from '@intafaced/venue-contracts';
import { assertPayoutGradeBook, type PayoutGradePolicy } from './payout-grade.js';
import { createVenueMarketDataAdapter } from './venues/factory.js';
import type { HttpPort } from './transport.js';

export type TradePayoutGateOptions = {
  readonly http?: HttpPort;
  readonly clock?: () => number;
  /** Snapshot depth. Unset is forwarded — Binance refuses rather than inventing 1000. */
  readonly limit?: number | null;
  /** Caller floor. Omitted is not filled in. A two-sided book then refuses. */
  readonly payoutPolicy?: PayoutGradePolicy | null;
};

/** Refuse place when the live book is not payout-grade. An omitted floor is not filled in. */
export async function assertTradeBookPayoutGradeBeforePlace(
  venueId: string,
  symbol: string,
  options: TradePayoutGateOptions = {},
): Promise<void> {
  const md = createVenueMarketDataAdapter(venueId, options);
  if (!md) {
    throw new VenueUnavailableError(venueId, 'not_ready', `${venueId}: no market-data adapter for payout-grade trade gate`);
  }
  // MarketDataAdapter.snapshotBook has no policy slot. These adapters take one.
  const snapshot = await (
    md as {
      snapshotBook(symbol: string, limit?: number | null, policy?: PayoutGradePolicy | null): Promise<VenueBookSnapshot>;
    }
  ).snapshotBook(symbol, options.limit ?? undefined, options.payoutPolicy);
  assertPayoutGradeBook(snapshot, options.payoutPolicy);
}
