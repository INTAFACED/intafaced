/**
 * Holdings change over a period on the launch model (J-portfolio-06 #3, PF-balances-02): what each coin in the person's
 * venue account held at the start of the range and now, and what rose or fell over the range.
 *
 * Worked out from the venue's own records: current balances (`balances`, plus vault equity where read), spot/perp fills
 * since `from` (`fills`, using the venue's ceiling quote rounding and fees), and credits from outside since `from`
 * (`arrivals`, or credited `deposits` when a venue exposes no arrivals list). `startAmount = endAmount - netChangeInWindow`.
 *
 * Prices: valued only where a published price applies (`valuation.prices`). Dollar coins (`USDT`, `USDC`) published at
 * par value both ends; volatile coins have no published historical price here, so `startValueUsd` stays null ("Not
 * priced"), never reusing today's price for a past moment.
 */
import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/money-math';
import type { ValuationPrices } from '@intafaced/contracts/valuation-prices';
import type { VenueArrival, VenueBalance, VenueFill } from '../../features/trade/venue-api';

export interface VenueMarketSides {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  kind: 'spot' | 'perpetual';
}

export interface VenueVaultEquity {
  asset: string;
  equity: string;
}

export interface VenueChangeRow {
  assetId: string;
  startAmount: string;
  endAmount: string;
  change: string;
  startPriceUsd: string | null;
  endPriceUsd: string | null;
  startValueUsd: string | null;
  endValueUsd: string | null;
}

export interface VenueHoldingsChange {
  from: string;
  to: string;
  rows: VenueChangeRow[];
}

function marketSides(
  fill: VenueFill,
  markets: ReadonlyMap<string, VenueMarketSides>,
): { base: string; quote: string; kind: 'spot' | 'perpetual' } {
  const listed = markets.get(fill.symbol);
  if (listed) return { base: listed.baseAsset, quote: listed.quoteAsset, kind: listed.kind };
  const [base = fill.symbol, quote = ''] = fill.symbol.split('-');
  if (!quote || quote === 'PERP') return { base, quote: fill.feeAsset, kind: 'perpetual' };
  return { base, quote, kind: 'spot' };
}

export function venueHoldingsChange(input: {
  fromIso: string;
  toIso: string;
  balances: readonly VenueBalance[];
  vaults?: readonly VenueVaultEquity[];
  markets: readonly VenueMarketSides[];
  fills: readonly VenueFill[];
  arrivals: readonly VenueArrival[];
  prices: ValuationPrices | null;
}): VenueHoldingsChange {
  const fromMs = Date.parse(input.fromIso);
  const endByAsset = new Map<string, Amount>();
  const addEnd = (asset: string, qty: Amount) => {
    if (qty === 0n) return;
    endByAsset.set(asset, (endByAsset.get(asset) ?? 0n) + qty);
  };
  for (const b of input.balances) addEnd(b.asset, parseAmount(b.total));
  for (const v of input.vaults ?? []) addEnd(v.asset, parseAmount(v.equity));

  const deltaByAsset = new Map<string, Amount>();
  const addDelta = (asset: string, by: Amount) => {
    if (by === 0n) return;
    deltaByAsset.set(asset, (deltaByAsset.get(asset) ?? 0n) + by);
  };

  for (const arrival of input.arrivals) {
    if (Date.parse(arrival.arrivedAt) < fromMs) continue;
    addDelta(arrival.asset, parseAmount(arrival.amount));
  }

  const marketMap = new Map(input.markets.map((m) => [m.symbol, m]));
  for (const fill of input.fills) {
    if (Date.parse(fill.filledAt) < fromMs) continue;
    const { base, quote, kind } = marketSides(fill, marketMap);
    const fee = parseAmount(fill.venueFee) + parseAmount(fill.builderFee);
    if (kind === 'spot') {
      const qty = parseAmount(fill.amount);
      const notional = mul(parseAmount(fill.price), qty, 'ceil');
      if (fill.side === 'buy') {
        addDelta(base, qty);
        addDelta(quote, -notional);
      } else {
        addDelta(base, -qty);
        addDelta(quote, notional);
      }
      addDelta(fill.feeAsset, -fee);
    } else {
      addDelta(fill.feeAsset, -fee);
      if (fill.realisedPnl !== null) addDelta(quote, parseAmount(fill.realisedPnl));
    }
  }

  const published = input.prices?.published ? input.prices : null;
  const priceOf = new Map((published?.prices ?? []).map((row) => [row.asset, parseAmount(row.usd)]));

  const assets = [...new Set([...endByAsset.keys(), ...deltaByAsset.keys()])].sort((a, b) => a.localeCompare(b));
  const rows: VenueChangeRow[] = [];
  for (const asset of assets) {
    const end = endByAsset.get(asset) ?? 0n;
    const change = deltaByAsset.get(asset) ?? 0n;
    const start = end - change;
    if (start === 0n && end === 0n) continue;
    const endPrice = priceOf.get(asset) ?? null;
    // Only dollar coins published at par carry that price at the start of a past window; volatile coins have no
    // historical price feed here and stay unpriced at the start rather than reusing today's price.
    const startPrice = asset === 'USDT' || asset === 'USDC' ? (priceOf.get(asset) ?? null) : null;
    rows.push({
      assetId: asset,
      startAmount: formatAmount(start),
      endAmount: formatAmount(end),
      change: formatAmount(change),
      startPriceUsd: startPrice === null ? null : formatAmount(startPrice),
      endPriceUsd: endPrice === null ? null : formatAmount(endPrice),
      startValueUsd: startPrice === null ? null : formatAmount(mul(start, startPrice)),
      endValueUsd: endPrice === null ? null : formatAmount(mul(end, endPrice)),
    });
  }

  return { from: input.fromIso, to: input.toIso, rows };
}
