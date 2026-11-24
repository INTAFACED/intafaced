import { parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { UserVenueMarket } from '@intafaced/venue-contracts';

/**
 * The terms of a market this adapter reads from the venue's listing and fee rates (`HyperliquidReads.markets`).
 */
export type ReadMarketTerm =
  | 'symbol'
  | 'kind'
  | 'baseAsset'
  | 'quoteAsset'
  | 'orderTypes'
  | 'timeInForce'
  | 'marginModes'
  | 'maxLeverageBps'
  | 'tickSize'
  | 'lotSize'
  | 'makerFeeBps'
  | 'takerFeeBps'
  | 'builderFeeCapBps';

export type ReadMarketTerms = Pick<UserVenueMarket, ReadMarketTerm>;

/**
 * The venue's own builder-fee cap, protocol-wide by market kind, not per market: "the builder fee is capped at 0.1% on
 * perps and 1% on spot" (Hyperliquid's builder-codes page, https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes,
 * read 24 Nov 2026). The venue itself refuses an approval or an order above it. What binds one order
 * below it is the trader's own approval (`maxBuilderFee`), which `prepare` checks per order.
 */
export const BUILDER_FEE_CAP_BPS: Readonly<Record<UserVenueMarket['kind'], Amount>> = {
  perpetual: parseAmount('10'),
  spot: parseAmount('100'),
};

/**
 * Every other term of `UserVenueMarket`, fresh for each market: this adapter does not read it, so it is not known (or null), never guessed.
 * A term the contract adds lands here by type: this fails to compile until it names it. When the adapter starts
 * reading a term, move its name into `ReadMarketTerm` and read it in `reads.ts`.
 */
export function unreadMarketTerms(): Omit<UserVenueMarket, ReadMarketTerm> {
  return {
    // The listing drops delisted markets and reports no halt or cancel-only state, nor a largest order: none is guessed.
    status: null,
    maxOrderQty: null,
    maxOrderNotional: null,
    // The smallest order value, price band and open-order cap are rules the venue states in its documentation, not
    // figures this adapter reads from the info API: each is not published here, never typed in. On spot our door then
    // refuses an order naming the missing rule (trade.venue_rule_unpublished, J-cex-spot-04 #6) until it is read.
    minOrderNotional: null,
    priceBandBps: null,
    maxOpenOrders: null,
    // Who listed it (a HIP-3 deployer), its oracle and mark rules, trading hours, feed state and home-market session
    // are not read from the info API by this adapter yet: each is not known, never guessed.
    listedBy: { known: false },
    oracleRule: { known: false },
    markRule: { known: false },
    tradingHours: { known: false },
    feed: { known: false },
    session: { known: false },
    // A HIP-3 deployer's own margin account and its open-interest cap are not read by this adapter yet: not known.
    marginAccount: { known: false },
    openInterest: { known: false },
    // A deployer's halt or a split, with the settlement it made, is not read by this adapter yet: not known.
    lastEvent: { known: false },
    // The contract strip's contract size, mark and funding (J-derivatives-01 #4) are not read by this adapter yet
    // (`metaAndAssetCtxs` carries mark and funding): each is not known, never guessed.
    contractSize: { known: false },
    mark: { known: false },
    funding: { known: false },
    // Its self-trade rule is not read from the venue by this adapter: not known, never guessed.
    selfTrade: { known: false },
  };
}
