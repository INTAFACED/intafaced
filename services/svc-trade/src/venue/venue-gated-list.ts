import type { ListedVenueMarket } from './venue-listing.js';

/**
 * THE VENUE DESK'S GATED LIST (J-derivatives-01 #2, D-ops-01): every perpetual we show on this venue, marked open or
 * blocked for this account, with every reason a new opening order on it would be refused and the first one named.
 *
 * It is a read and opens nothing: the open path runs its own checks (the region and level gate every venue route runs,
 * our builder fee, our listing, the venue's own market state). The same checks are asked here one by one, so the person
 * sees every reason at once instead of one per attempt. No agreement, quiz or notice is a reason (owner decision
 * 2026-10-27, until launch prep). The venue's own state is the venue's word: we name it, never replace it.
 */

export interface VenueGatedBlocker {
  readonly code: string;
  readonly message: string;
}

export interface VenueGatedContract {
  readonly symbol: string;
  readonly open: boolean;
  /** The first blocking reason, or null when open. */
  readonly code: string | null;
  readonly message: string | null;
  readonly blockers: readonly VenueGatedBlocker[];
}

export interface VenueGatedInput {
  /** The venue markets we show (an approved listing), as the door reads them. */
  readonly markets: readonly ListedVenueMarket[];
  /** The region and level gate for this account, or null when it may trade. Applies to every contract. */
  readonly account: VenueGatedBlocker | null;
  /** Whether our builder fee is published for this contract (a perp order always carries it). */
  readonly builderFeePublished: (symbol: string) => boolean;
  readonly venueName: string;
}

function listingBlockers(m: ListedVenueMarket): VenueGatedBlocker[] {
  const out: VenueGatedBlocker[] = [];
  const l = m.listing;
  if (l.routing === 'stop')
    out.push({ code: 'trade.venue_routing_stopped', message: `INTAFACED stopped routing new orders to ${m.symbol}` });
  if (!l.open)
    out.push({
      code: 'trade.venue_market_not_open',
      message: `${m.symbol} opens on INTAFACED at ${l.opensAt.toISOString()}; no order is routed before then`,
    });
  if (l.delisted)
    out.push({
      code: 'trade.venue_market_delisted',
      message: `${m.symbol} was delisted on INTAFACED at ${l.delistsAt!.toISOString()}; only closing (reduce-only) orders are routed`,
    });
  if (l.routing === 'close_only')
    out.push({ code: 'trade.venue_routing_close_only', message: `INTAFACED routes only closing (reduce-only) orders to ${m.symbol}` });
  return out;
}

function venueStateBlocker(m: ListedVenueMarket, venueName: string): VenueGatedBlocker | null {
  if (m.status === null || m.status === 'trading') return null;
  const words = { halted: 'halted', cancel_only: 'taking cancels only', delisted: 'delisted' }[m.status];
  return { code: `trade.venue.market_${m.status}`, message: `${venueName} reports ${m.symbol} ${words}` };
}

export function venueGatedList(input: VenueGatedInput): VenueGatedContract[] {
  return input.markets
    .filter((m) => m.kind === 'perpetual')
    .map((m) => {
      const fee: VenueGatedBlocker | null = input.builderFeePublished(m.symbol)
        ? null
        : { code: 'trade.venue.builder_fee_not_published', message: 'Our builder fee is not published, so no order is prepared' };
      const blockers = [input.account, fee, ...listingBlockers(m), venueStateBlocker(m, input.venueName)].filter(
        (b): b is VenueGatedBlocker => b !== null,
      );
      const first = blockers[0] ?? null;
      return { symbol: m.symbol, open: first === null, code: first?.code ?? null, message: first?.message ?? null, blockers };
    });
}
