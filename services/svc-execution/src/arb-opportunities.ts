/**
 * Customer read of funding and spread opportunities (CB-execution-06).
 *
 * Wraps the same scan as the staff door (`oms-arbitrage.ts`, `@intafaced/execution-arb`) for two classes only:
 * `funding` and the cross-exchange `spread`. It is a READ: no order is planned, held or placed from here.
 *
 * Where the inputs come from is a port. This build wires none, so the read answers the allowlisted NotConnected
 * `feed.market` and shows no row. With a feed attached, every blank the scanner already refuses (empty book, blank
 * funding rate, missing or stale quote, blank owner freshness window) comes back as a refused row, never as an
 * invented spread, mid or rate.
 */
import type { SorCostTerms } from '@intafaced/venue-adapter';
import { scanOmsExternalArb, type OmsArbOpportunityWire, type OmsArbQuoteInput, type OmsArbScanResultWire } from './oms-arbitrage.js';

export const ARB_OPPORTUNITY_CLASSES = ['funding', 'spread'] as const;
export type ArbOpportunityClass = (typeof ARB_OPPORTUNITY_CLASSES)[number];

export const FEED_MARKET_NOT_CONNECTED = 'feed.market' as const;
export const FEED_MARKET_NOT_CONNECTED_MESSAGE = 'Needs a market feed. It is switched off in this build.';

/** What one feed read supplies for a symbol. Every number stays a decimal string or an owner value. */
export type ArbOpportunityFeedRead = {
  readonly quotes: readonly OmsArbQuoteInput[];
  readonly costTermsByVenue: Readonly<Record<string, SorCostTerms>>;
  readonly inventory: { readonly prePositionedByVenue: Readonly<Record<string, boolean>> };
  /** Owner freshness window. Null: every quote is stale (the scanner refuses). */
  readonly maxQuoteAgeMs: number | null;
  /** Funding rate as a decimal string. Null or blank: the funding row refuses "not set". */
  readonly fundingRate: string | null;
};

export interface ArbOpportunityFeed {
  read(symbol: string): Promise<ArbOpportunityFeedRead>;
}

export type ArbOpportunityRow = {
  readonly scanClass: ArbOpportunityClass;
  readonly opportunities: readonly OmsArbOpportunityWire[];
  readonly refused: OmsArbScanResultWire['refused'];
};

export type ArbOpportunitiesResult =
  | { readonly status: 'not_connected'; readonly code: typeof FEED_MARKET_NOT_CONNECTED; readonly message: string }
  | { readonly status: 'ok'; readonly symbol: string; readonly amount: string; readonly rows: readonly ArbOpportunityRow[] };

function scanClassFor(c: ArbOpportunityClass): 'funding' | 'cross-exchange' {
  return c === 'funding' ? 'funding' : 'cross-exchange';
}

export async function readArbOpportunities(input: {
  readonly feed: ArbOpportunityFeed | undefined;
  readonly symbol: string;
  readonly amount: string;
  readonly nowMs: number;
}): Promise<ArbOpportunitiesResult> {
  if (!input.feed) {
    return { status: 'not_connected', code: FEED_MARKET_NOT_CONNECTED, message: FEED_MARKET_NOT_CONNECTED_MESSAGE };
  }
  const read = await input.feed.read(input.symbol);
  const rows = ARB_OPPORTUNITY_CLASSES.map((scanClass): ArbOpportunityRow => {
    const scanned = scanOmsExternalArb({
      symbol: input.symbol,
      amount: input.amount,
      quotes: read.quotes,
      costTermsByVenue: read.costTermsByVenue,
      inventory: read.inventory,
      nowMs: input.nowMs,
      maxQuoteAgeMs: read.maxQuoteAgeMs,
      scanClass: scanClassFor(scanClass),
      fundingRate: scanClass === 'funding' ? read.fundingRate : undefined,
    });
    return { scanClass, opportunities: scanned.opportunities, refused: scanned.refused };
  });
  return { status: 'ok', symbol: input.symbol, amount: input.amount, rows };
}
