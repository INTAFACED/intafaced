import { venueDoorOff, venueMarketRow, type Loadable, type MarketData, type TickerRow, type VenueMarketStates } from './deps';

type Markets = Loadable<MarketData[]>;
type Tickers = Loadable<Record<string, TickerRow>>;

const pairKey = (market: Pick<MarketData, 'base' | 'quote'>) => `${market.base}/${market.quote}`;

/**
 * Align ticker keys with the merged market symbols: `/api/v1/tickers` keys spot pairs with a slash (`BTC/USDC`) while
 * `/api/v1/venue/market-states` keys them with a dash (`BTC-USDC`), so each row finds its price under its own symbol.
 */
function alignTickers(rows: readonly MarketData[], tickers: Tickers): Tickers {
  if (tickers.status !== 'ready') return tickers;
  let aligned: Record<string, TickerRow> | null = null;
  for (const row of rows) {
    if (row.symbol in tickers.data) continue;
    const matched = tickers.data[`${row.base}/${row.quote}`] ?? tickers.data[`${row.base}-${row.quote}`];
    if (!matched) continue;
    aligned ??= { ...tickers.data };
    aligned[row.symbol] = matched;
  }
  return aligned ? { status: 'ready', data: aligned, asOf: tickers.asOf } : tickers;
}

/**
 * Combines the venue's spot markets with the API's spot markets while the venue read answers (venue state wins on any
 * shared base/quote pair, and tickers from `/api/v1/tickers` attach to matching rows), keeps the own read where the
 * venue door is off, and surfaces the venue read's loading, refusal or failure otherwise.
 */
export function pickSource(venue: Loadable<VenueMarketStates>, own: Markets, ownTickers: Tickers): { markets: Markets; tickers: Tickers } {
  if (venueDoorOff(venue)) return { markets: own, tickers: ownTickers };
  if (venue.status !== 'ready') return { markets: venue as Markets, tickers: { status: 'empty' } };
  if (own.status === 'loading') return { markets: { status: 'loading' }, tickers: ownTickers };
  const venueRows = venue.data.value.markets.filter((m) => m.kind === 'spot').map(venueMarketRow);
  const seenPairs = new Set(venueRows.map(pairKey));
  const extraOwn = own.status === 'ready' ? own.data.filter((m) => !seenPairs.has(pairKey(m))) : [];
  const rows = [...venueRows, ...extraOwn];
  const asOf = own.status === 'ready' ? Math.max(venue.asOf, own.asOf) : venue.asOf;
  return {
    markets: rows.length === 0 ? { status: 'empty' } : { status: 'ready', data: rows, asOf },
    tickers: alignTickers(rows, ownTickers),
  };
}
