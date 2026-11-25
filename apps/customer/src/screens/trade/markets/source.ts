import {
  venueDoorOff,
  venueMarketRow,
  venueTickerRow,
  type Loadable,
  type MarketData,
  type TickerRow,
  type VenueMarketStates,
  type VenueTickersRead,
} from './deps';

type Markets = Loadable<MarketData[]>;
type Tickers = Loadable<Record<string, TickerRow>>;

/**
 * The venue's prices on its listed spot markets, as the markets list reads them: its own read's loading, refusal or
 * failure stands as it is (a row then shows no price), and never our own book's prices in its place.
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
): { markets: Markets; tickers: Tickers } {
  if (venueDoorOff(venue)) return { markets: own, tickers: ownTickers };
  if (venue.status !== 'ready') return { markets: venue as Markets, tickers: { status: 'empty' } };
  const rows = venue.data.value.markets.filter((m) => m.kind === 'spot').map(venueMarketRow);
  return {
    markets: rows.length === 0 ? { status: 'empty' } : { status: 'ready', data: rows, asOf: venue.asOf },
    tickers: venuePrices(venueTickers),
  };
}
