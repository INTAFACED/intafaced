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
  | 'minOrderNotional'
  | 'maxOpenOrders'
  | 'status'
  | 'makerFeeBps'
  | 'takerFeeBps'
  | 'builderFeeCapBps'
  | 'contractSize'
  | 'mark'
  | 'funding';

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
 * One perpetual contract on Hyperliquid: "Contract: 1 unit of underlying spot asset" (Hyperliquid contract
 * specifications, https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications, read 27 Nov 2026).
 */
export const PERP_CONTRACT_SIZE: Amount = parseAmount('1');

/**
 * Hyperliquid's protocol-wide smallest order value: "Order must have minimum value of 10 {quote_token}" (spot) and "$10"
 * (perps) (Hyperliquid error-responses docs, read 24 Nov 2026).
 */
export const MIN_ORDER_NOTIONAL: Amount = parseAmount('10');

/**
 * Hyperliquid's default open-order cap per account: "a default open order limit of 1000 plus one additional order for
 * every 5M USDC of volume, capped at a total of 5000" (Hyperliquid rate-limits docs, read 24 Nov 2026).
 */
export const DEFAULT_MAX_OPEN_ORDERS = 1000;

/**
 * Every other term of `UserVenueMarket`, fresh for each market: this adapter does not read it, so it is not known (or null), never guessed.
 * A term the contract adds lands here by type: this fails to compile until it names it. When the adapter starts
 * reading a term, move its name into `ReadMarketTerm` and read it in `reads.ts`.
 */
export function unreadMarketTerms(): Omit<UserVenueMarket, ReadMarketTerm> {
  return {
    // No largest order is published: none is guessed.
    maxOrderQty: null,
    maxOrderNotional: null,
    // Hyperliquid publishes no figure for its price band (error-responses docs state only "order too far from reference
    // price"), so it stays null and is left to Hyperliquid to enforce (J-cex-spot-04 #6).
    priceBandBps: null,
    priceBand: { known: false },
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
    // Its self-trade rule is not read from the venue by this adapter: not known, never guessed.
    selfTrade: { known: false },
  };
}
