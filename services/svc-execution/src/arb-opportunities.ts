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

/** Local for now; move to packages/contracts with the screen half (Contracts bot). */
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

/** Typed refusals of this read. Blank inputs never reach the scanner. */
export const ARB_OPPORTUNITY_AMOUNT_UNSET = 'execution.arb.amount_unset' as const;
export const ARB_OPPORTUNITY_SYMBOL_UNSET = 'execution.arb.symbol_unset' as const;
export const ARB_OPPORTUNITY_FEED_UNAVAILABLE = 'execution.arb.feed_unavailable' as const;

export class ArbOpportunityError extends Error {
  constructor(
    readonly code: typeof ARB_OPPORTUNITY_AMOUNT_UNSET | typeof ARB_OPPORTUNITY_SYMBOL_UNSET | typeof ARB_OPPORTUNITY_FEED_UNAVAILABLE,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ArbOpportunityError';
  }
}

/**
 * What a customer may see of a row refusal: a code and a plain label. The scanner's free-text detail, venue ids,
 * cost terms and all-in prices are staff data and never leave this module.
 */
export const CUSTOMER_REFUSAL_LABELS = {
  funding_rate_unset: 'Funding rate not set',
  empty_book: 'No order book to compare',
  missing_quote: 'A price is missing',
  stale_quote: 'Prices are out of date',
  missing_cost_terms: 'Costs are not set',
  incomplete_cost: 'Costs are not set',
  zero_weight: 'Costs are not set',
  inventory_missing: 'Not available on both venues',
  same_venue: 'Not available on two venues',
  internal_venue: 'Not available on two venues',
  no_edge: 'No opportunity after costs',
  insufficient_size: 'Not enough size on the book',
  size_refused: 'Not enough size on the book',
  amount_conflict: 'Amount does not fit the book',
  capital_unset: 'Not available',
  capital_invalid: 'Not available',
  unavailable: 'Not available',
} as const;
export type CustomerRefusalCode = keyof typeof CUSTOMER_REFUSAL_LABELS;

export type CustomerArbRefusal = { readonly code: CustomerRefusalCode; readonly label: string };

/** Customer projection of one opportunity: the two legs by kind, the amount and the edge per unit. No venue, no cost. */
export type CustomerArbOpportunity = {
  readonly legs: readonly [{ readonly side: 'buy'; readonly kind: string }, { readonly side: 'sell'; readonly kind: string }];
  readonly amount: string;
  readonly edgePerUnit: string;
};

export type ArbOpportunityRow = {
  readonly scanClass: ArbOpportunityClass;
  readonly opportunities: readonly CustomerArbOpportunity[];
  readonly refused: readonly CustomerArbRefusal[];
};

export type ArbOpportunitiesResult =
  | { readonly status: 'not_connected'; readonly code: typeof FEED_MARKET_NOT_CONNECTED; readonly message: string }
  | { readonly status: 'ok'; readonly symbol: string; readonly amount: string; readonly rows: readonly ArbOpportunityRow[] };

function scanClassFor(c: ArbOpportunityClass): 'funding' | 'cross-exchange' {
  return c === 'funding' ? 'funding' : 'cross-exchange';
}

function refusal(code: CustomerRefusalCode): CustomerArbRefusal {
  return { code, label: CUSTOMER_REFUSAL_LABELS[code] };
}

function customerRefusal(row: OmsArbScanResultWire['refused'][number]): CustomerArbRefusal {
  if (row.detail.startsWith('empty book')) return refusal('empty_book');
  return refusal(row.reason in CUSTOMER_REFUSAL_LABELS ? (row.reason as CustomerRefusalCode) : 'unavailable');
}

function dedupe(rows: readonly CustomerArbRefusal[]): CustomerArbRefusal[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.code) ? false : (seen.add(r.code), true)));
}

function customerOpportunity(o: OmsArbOpportunityWire): CustomerArbOpportunity {
  return {
    legs: [
      { side: 'buy', kind: o.buyKind },
      { side: 'sell', kind: o.sellKind },
    ],
    amount: o.amount,
    edgePerUnit: o.edgePerUnit,
  };
}

/**
 * Amount `0` is passed to the scanner as given (it is a deliberate value, not a blank); the scanner lists nothing
 * for it and the rows carry its refusal.
 */
export async function readArbOpportunities(input: {
  readonly feed: ArbOpportunityFeed | undefined;
  readonly symbol: string;
  readonly amount: string;
  readonly nowMs: number;
}): Promise<ArbOpportunitiesResult> {
  if (input.symbol.trim().length === 0) {
    throw new ArbOpportunityError(ARB_OPPORTUNITY_SYMBOL_UNSET, 'symbol is blank; no instrument is assumed', false);
  }
  if (input.amount.trim().length === 0) {
    throw new ArbOpportunityError(ARB_OPPORTUNITY_AMOUNT_UNSET, 'amount is blank; no size is assumed', false);
  }
  if (!input.feed) {
    return { status: 'not_connected', code: FEED_MARKET_NOT_CONNECTED, message: FEED_MARKET_NOT_CONNECTED_MESSAGE };
  }
  let read: ArbOpportunityFeedRead;
  try {
    read = await input.feed.read(input.symbol);
  } catch {
    throw new ArbOpportunityError(ARB_OPPORTUNITY_FEED_UNAVAILABLE, 'the market feed did not answer; retry', true);
  }
  const rows = ARB_OPPORTUNITY_CLASSES.map((scanClass): ArbOpportunityRow => {
    if (scanClass === 'funding' && (read.fundingRate ?? '').trim().length === 0) {
      return { scanClass, opportunities: [], refused: [refusal('funding_rate_unset')] };
    }
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
    return {
      scanClass,
      opportunities: scanned.opportunities.map(customerOpportunity),
      refused: dedupe(scanned.refused.map(customerRefusal)),
    };
  });
  return { status: 'ok', symbol: input.symbol, amount: input.amount, rows };
}
