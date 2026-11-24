import { venueDoorOff, venueMarketRow, type Loadable, type MarketData, type TickerRow, type VenueMarketStates } from './deps';

type Markets = Loadable<MarketData[]>;
type Tickers = Loadable<Record<string, TickerRow>>;

/**
 * The venue's markets while its read answers (its spot markets, with no prices of our own book beside them), today's
 * read where the venue door is off here, and the venue read's own loading, refusal or failure otherwise: a venue that
 * does not answer is never stood in for by our own book.
 */
export function pickSource(venue: Loadable<VenueMarketStates>, own: Markets, ownTickers: Tickers): { markets: Markets; tickers: Tickers } {
  if (venueDoorOff(venue)) return { markets: own, tickers: ownTickers };
  if (venue.status !== 'ready') return { markets: venue as Markets, tickers: { status: 'empty' } };
  const rows = venue.data.value.markets.filter((m) => m.kind === 'spot').map(venueMarketRow);
  return {
    markets: rows.length === 0 ? { status: 'empty' } : { status: 'ready', data: rows, asOf: venue.asOf },
    tickers: { status: 'empty' },
  };
}
