import { SCALE, div, formatAmount, mul, sub, type Amount } from '@intafaced/ledger-client';
import type { OrderSide } from '../spot/types.js';

/**
 * Derived result of a schedule (TRD-0067, TRD-0563).
 *
 * Computed from child fills at read time. Never stored on the parent.
 * The parent type stays free of avgPrice, pnl, and notional.
 *
 * Money scale is the ledger's 18 decimal places (`SCALE` = 10^18).
 * Notional is the sum of price × quantity. price and qty are each scaled
 * by 10^18, so each product is scaled by 10^36. Those products are summed
 * with no intermediate rounding, then divided by 10^18 once.
 * When the sum is divisible by 10^18 the notional is exact.
 * When it is not, the one scale reduction rounds half-up
 * (`RESULT_ROUNDING`). That is a scale rule, not a fee and not a haircut.
 *
 * Average fill price is notional ÷ filled quantity at the same 18 decimal
 * places, half-up (`AVERAGE_FILL_PRICE_ROUNDING`). Null when filled
 * quantity is zero — never an invented price.
 *
 * Fees are the fills' own fee amounts, summed per fee asset. They are
 * never recomputed from fee bps. One fill with a blank fee asset or a
 * missing fee amount makes `feesPaid` null and `feesReason` `fee_not_recorded`.
 *
 * Shortfall is (average − arrival) × filled quantity on a buy, and
 * (arrival − average) × filled quantity on a sell, half-up at 18 decimals.
 * A positive number is worse for the customer on both sides. Null, with
 * `shortfallMissing.code = missing_input`, when average or arrival is null.
 * The `fields` array names every null input.
 */

export const RESULT_MONEY_DECIMALS = 18;
export const RESULT_ROUNDING = 'half-up' as const;
export const AVERAGE_FILL_PRICE_ROUNDING = RESULT_ROUNDING;

export const ARRIVAL_NOT_RECORDED = 'arrival_not_recorded' as const;
export const FEE_NOT_RECORDED = 'fee_not_recorded' as const;
export const SHORTFALL_MISSING_INPUT = 'missing_input' as const;

export interface AlgoResultFill {
  readonly price: Amount;
  readonly qty: Amount;
  readonly quoteAsset: string;
  /** Absent or blank → the quote bucket's fees are not recorded. */
  readonly feeAsset?: string | null;
  readonly feeAmount?: Amount | null;
}

export interface AlgoFeePaid {
  readonly asset: string;
  readonly amount: string;
}

export interface AlgoShortfallMissing {
  readonly code: typeof SHORTFALL_MISSING_INPUT;
  readonly fields: Array<'averageFillPrice' | 'arrivalPrice'>;
}

export interface AlgoQuoteResult {
  readonly quoteAsset: string;
  readonly filledQty: string;
  readonly notional: string;
  readonly averageFillPrice: string | null;
  readonly feesPaid: AlgoFeePaid[] | null;
  readonly feesReason: typeof FEE_NOT_RECORDED | null;
  readonly arrivalPrice: string | null;
  readonly arrivalReason: typeof ARRIVAL_NOT_RECORDED | null;
  readonly shortfall: string | null;
  readonly shortfallMissing: AlgoShortfallMissing | null;
}

export interface AlgoResult {
  readonly quotes: AlgoQuoteResult[];
}

export interface DeriveAlgoResultInput {
  readonly side: OrderSide;
  readonly quoteAsset: string;
  readonly fills: readonly AlgoResultFill[];
  readonly arrivalPrice: Amount | null;
}

/** Sum of price×qty reduced to 18 decimal ledger units. See file header. */
export function notionalFromFills(fills: readonly AlgoResultFill[]): Amount {
  let product = 0n;
  for (const fill of fills) product += fill.price * fill.qty;
  return reduceScale36(product);
}

function reduceScale36(product: bigint): Amount {
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  let quote = magnitude / SCALE;
  const remainder = magnitude % SCALE;
  if (remainder * 2n >= SCALE) quote += 1n;
  return negative ? -quote : quote;
}

function feesFor(fills: readonly AlgoResultFill[]): { feesPaid: AlgoFeePaid[] | null; feesReason: typeof FEE_NOT_RECORDED | null } {
  if (fills.length === 0) return { feesPaid: [], feesReason: null };
  const totals = new Map<string, Amount>();
  for (const fill of fills) {
    const asset = fill.feeAsset?.trim() ?? '';
    if (asset === '' || fill.feeAmount == null) return { feesPaid: null, feesReason: FEE_NOT_RECORDED };
    totals.set(asset, (totals.get(asset) ?? 0n) + fill.feeAmount);
  }
  const feesPaid = [...totals.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([asset, amount]) => ({ asset, amount: formatAmount(amount) }));
  return { feesPaid, feesReason: null };
}

function shortfallFor(
  side: OrderSide,
  average: Amount | null,
  arrival: Amount | null,
  filledQty: Amount,
): {
  shortfall: string | null;
  shortfallMissing: AlgoShortfallMissing | null;
} {
  const fields: Array<'averageFillPrice' | 'arrivalPrice'> = [];
  if (average == null) fields.push('averageFillPrice');
  if (arrival == null) fields.push('arrivalPrice');
  if (fields.length > 0 || average == null || arrival == null) {
    return { shortfall: null, shortfallMissing: { code: SHORTFALL_MISSING_INPUT, fields } };
  }
  const gap = side === 'sell' ? sub(arrival, average) : sub(average, arrival);
  return { shortfall: formatAmount(mul(gap, filledQty, RESULT_ROUNDING)), shortfallMissing: null };
}

function quoteResult(quoteAsset: string, side: OrderSide, fills: readonly AlgoResultFill[], arrivalPrice: Amount | null): AlgoQuoteResult {
  let filled = 0n;
  for (const fill of fills) filled += fill.qty;
  const notional = notionalFromFills(fills);
  const average = filled === 0n ? null : div(notional, filled, AVERAGE_FILL_PRICE_ROUNDING);
  const fees = feesFor(fills);
  const cost = shortfallFor(side, average, arrivalPrice, filled);
  return {
    quoteAsset,
    filledQty: formatAmount(filled),
    notional: formatAmount(notional),
    averageFillPrice: average == null ? null : formatAmount(average),
    feesPaid: fees.feesPaid,
    feesReason: fees.feesReason,
    arrivalPrice: arrivalPrice == null ? null : formatAmount(arrivalPrice),
    arrivalReason: arrivalPrice == null ? ARRIVAL_NOT_RECORDED : null,
    shortfall: cost.shortfall,
    shortfallMissing: cost.shortfallMissing,
  };
}

/** Pure result. `quoteAsset` is the parent's market quote, used when there are no fills. */
export function deriveAlgoResult(input: DeriveAlgoResultInput): AlgoResult {
  const byQuote = new Map<string, AlgoResultFill[]>();
  for (const fill of input.fills) {
    const bucket = byQuote.get(fill.quoteAsset) ?? [];
    bucket.push(fill);
    byQuote.set(fill.quoteAsset, bucket);
  }
  if (byQuote.size === 0) byQuote.set(input.quoteAsset, []);
  const quotes = [...byQuote.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([quoteAsset, fills]) => quoteResult(quoteAsset, input.side, fills, input.arrivalPrice));
  return { quotes };
}
