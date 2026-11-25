import { useMemo } from 'react';
import { useMarkets, useTickers } from './hooks';
import type { Loadable, MarketRow, TickerRow } from './types';
import {
  useVenueMarketStates,
  useVenueTickers,
  venueDoorOff,
  venueMarketRow,
  venueTickerRow,
  type VenueMarketStates,
  type VenueTickersRead,
} from './venue-market-states';

type Markets = Loadable<MarketRow[]>;
type Tickers = Loadable<Record<string, TickerRow>>;

/** The markets every room lists and the prices beside them, and whose they are. */
export interface MarketCatalogue {
  markets: Markets;
  tickers: Tickers;
  /**
   * The venue's listed perpetuals (gold and stocks are listed only as perpetuals), priced from `tickers` under their own
   * symbols. Empty where the door is off: our own book lists no perpetuals.
   */
  perpetuals: Markets;
  /** `venue` while the venue door is on here (its markets, its prices), `own` where it is off (today's reads). */
  source: 'venue' | 'own';
}

/**
 * The venue's prices on its listed spot markets: its own read's loading, refusal or failure stands as it is (a row then
 * shows no price), and never our own book's prices in its place.
 */
function venuePrices(read: Loadable<VenueTickersRead>): Tickers {
  if (read.status !== 'ready') return read as Tickers;
  const rows = Object.values(read.data.value).map(venueTickerRow);
  return rows.length === 0
    ? { status: 'empty' }
    : { status: 'ready', asOf: read.asOf, data: Object.fromEntries(rows.map((r) => [r.symbol, r])) };
}

/**
 * The venue's markets while its read answers (its spot markets, each with the venue's own prices), today's read where
 * the venue door is off here, and the venue read's own loading, refusal or failure otherwise: a venue that does not
 * answer is never stood in for by our own book.
 */
export function pickSource(
  venue: Loadable<VenueMarketStates>,
  own: Markets,
  ownTickers: Tickers,
  venueTickers: Loadable<VenueTickersRead>,
): MarketCatalogue {
  if (venueDoorOff(venue)) return { markets: own, tickers: ownTickers, perpetuals: { status: 'empty' }, source: 'own' };
  if (venue.status !== 'ready')
    return { markets: venue as Markets, tickers: { status: 'empty' }, perpetuals: venue as Markets, source: 'venue' };
  const listed = (kind: string): Markets => {
    const rows = venue.data.value.markets.filter((m) => m.kind === kind).map(venueMarketRow);
    return rows.length === 0 ? { status: 'empty' } : { status: 'ready', data: rows, asOf: venue.asOf };
  };
  return {
    markets: listed('spot'),
    perpetuals: listed('perpetual'),
    tickers: venuePrices(venueTickers),
    source: 'venue',
  };
}

/**
 * The one markets catalogue: every room that lists markets or their prices (Markets, Home, Home Pro) reads this, so
 * with the venue on they all show the venue's markets at the venue's prices, and with it off they all show today's.
 * Closed and paused markets are included; a room that shows only orderable ones filters on `orderable`.
 */
export function useMarketCatalogue(): MarketCatalogue {
  const own = useMarkets({ includeClosed: true });
  const ownTickers = useTickers();
  const venue = useVenueMarketStates();
  const venueTickers = useVenueTickers();
  return useMemo(() => pickSource(venue, own, ownTickers, venueTickers), [venue, own, ownTickers, venueTickers]);
}
