import { SCALE, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
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
 * Average fill price is the unrounded scale-36 sum ÷ filled quantity, one
 * half-up reduction to 18 decimal places (`AVERAGE_FILL_PRICE_ROUNDING`).
 * Null when filled quantity is zero — never an invented price.
 *
 * Fees are the fills' own fee amounts, summed per fee asset. They are
 * never recomputed from fee bps. One fill with a blank fee asset or a
 * missing fee amount makes `feesPaid` null and `feesReason` `fee_not_recorded`.
 *
 * Shortfall is notional − arrival × filled quantity on a buy, and
 * arrival × filled quantity − notional on a sell. Both terms stay at scale
 * 36 and the difference is reduced to 18 decimals once, half-up. It is not
 * built from the rounded average, so it carries no double rounding.
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

/**
 * Totals for one quote asset. The production read aggregates these in SQL
 * over every child fill (no row cap), so a large schedule is not truncated.
 */
export interface AlgoResultTotals {
  readonly quoteAsset: string;
  readonly filledQty: Amount;
  /** Σ price×qty at scale 10^36, unrounded. */
  readonly notional36: bigint;
  /** Per fee asset. Null when any fill has no recorded fee. */
  readonly fees: ReadonlyMap<string, Amount> | null;
}

/** Sum of price×qty reduced to 18 decimal ledger units. See file header. */
export function notionalFromFills(fills: readonly AlgoResultFill[]): Amount {
  let product = 0n;
  for (const fill of fills) product += fill.price * fill.qty;
  return reduceScale36(product);
}

/** Divide by 10^18 once, half-up (away from zero). */
function reduceScale36(product: bigint): Amount {
  return divHalfUp(product, SCALE);
}

function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quote = n / d;
  if ((n % d) * 2n >= d) quote += 1n;
  return negative ? -quote : quote;
}

const SCALE_36_DECIMALS = 36;
const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Parse a Postgres numeric text at scale 10^36. More than 36 decimals refuses. */
export function parseScale36(text: string): bigint {
  const m = DECIMAL_RE.exec(text.trim());
  if (!m) throw new Error(`algo result: malformed numeric "${text}"`);
  const [, sign, whole, frac = ''] = m;
  if (frac.length > SCALE_36_DECIMALS) throw new Error(`algo result: numeric "${text}" exceeds 36 decimal places`);
  const value = BigInt(whole!) * 10n ** BigInt(SCALE_36_DECIMALS) + BigInt(frac.padEnd(SCALE_36_DECIMALS, '0') || '0');
  return sign === '-' ? -value : value;
}

function totalsFromFills(quoteAsset: string, fills: readonly AlgoResultFill[]): AlgoResultTotals {
  let filledQty = 0n;
  let notional36 = 0n;
  let fees: Map<string, Amount> | null = new Map();
  for (const fill of fills) {
    filledQty += fill.qty;
    notional36 += fill.price * fill.qty;
    const asset = fill.feeAsset?.trim() ?? '';
    if (asset === '' || fill.feeAmount == null) fees = null;
    else if (fees) fees.set(asset, (fees.get(asset) ?? 0n) + fill.feeAmount);
  }
  return { quoteAsset, filledQty, notional36, fees };
}

function feesFor(fees: ReadonlyMap<string, Amount> | null): {
  feesPaid: AlgoFeePaid[] | null;
  feesReason: typeof FEE_NOT_RECORDED | null;
} {
  if (fees == null) return { feesPaid: null, feesReason: FEE_NOT_RECORDED };
  const feesPaid = [...fees.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([asset, amount]) => ({ asset, amount: formatAmount(amount) }));
  return { feesPaid, feesReason: null };
}

function shortfallFor(
  side: OrderSide,
  totals: AlgoResultTotals,
  average: Amount | null,
  arrival: Amount | null,
): {
  shortfall: string | null;
  shortfallMissing: AlgoShortfallMissing | null;
} {
  const fields: Array<'averageFillPrice' | 'arrivalPrice'> = [];
  if (average == null) fields.push('averageFillPrice');
  if (arrival == null) fields.push('arrivalPrice');
  if (fields.length > 0 || arrival == null) {
    return { shortfall: null, shortfallMissing: { code: SHORTFALL_MISSING_INPUT, fields } };
  }
  const atArrival36 = arrival * totals.filledQty;
  const gap36 = side === 'sell' ? atArrival36 - totals.notional36 : totals.notional36 - atArrival36;
  return { shortfall: formatAmount(reduceScale36(gap36)), shortfallMissing: null };
}

function quoteResult(side: OrderSide, totals: AlgoResultTotals, arrivalPrice: Amount | null): AlgoQuoteResult {
  const filled = totals.filledQty;
  const notional = reduceScale36(totals.notional36);
  const average = filled === 0n ? null : divHalfUp(totals.notional36, filled);
  const fees = feesFor(totals.fees);
  const cost = shortfallFor(side, totals, average, arrivalPrice);
  return {
    quoteAsset: totals.quoteAsset,
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

/** Result from per-quote totals (the SQL path). Empty totals → one zero row for `quoteAsset`. */
export function deriveAlgoResultFromTotals(input: {
  readonly side: OrderSide;
  readonly quoteAsset: string;
  readonly totals: readonly AlgoResultTotals[];
  readonly arrivalPrice: Amount | null;
}): AlgoResult {
  const totals =
    input.totals.length > 0
      ? [...input.totals]
      : [{ quoteAsset: input.quoteAsset, filledQty: 0n, notional36: 0n, fees: new Map<string, Amount>() }];
  const quotes = totals
    .sort((a, b) => (a.quoteAsset < b.quoteAsset ? -1 : a.quoteAsset > b.quoteAsset ? 1 : 0))
    .map((t) => quoteResult(input.side, t, input.arrivalPrice));
  return { quotes };
}

/** Pure result. `quoteAsset` is the parent's market quote, used when there are no fills. */
export function deriveAlgoResult(input: DeriveAlgoResultInput): AlgoResult {
  const byQuote = new Map<string, AlgoResultFill[]>();
  for (const fill of input.fills) {
    const bucket = byQuote.get(fill.quoteAsset) ?? [];
    bucket.push(fill);
    byQuote.set(fill.quoteAsset, bucket);
  }
  return deriveAlgoResultFromTotals({
    side: input.side,
    quoteAsset: input.quoteAsset,
    totals: [...byQuote.entries()].map(([quoteAsset, fills]) => totalsFromFills(quoteAsset, fills)),
    arrivalPrice: input.arrivalPrice,
  });
}

/**
 * Aggregate the caller's own fills on these child orders in SQL. Every fill
 * counts (no page cap). A child whose order row is gone simply has no fills
 * here, so one missing row does not fail the whole read. Scoped by user_id.
 * Returns null totals when there are no fills.
 */
export async function loadAlgoChildFillTotals(
  sql: Sql,
  userId: string,
  orderIds: readonly string[],
  quoteAsset: string,
): Promise<AlgoResultTotals | null> {
  if (orderIds.length === 0) return null;
  const ids = [...orderIds];
  const sums = await sql<Array<{ n: number; qty: string; notional: string; fee_missing: number }>>`
    SELECT
      COUNT(*)::int AS n,
      COALESCE(SUM(qty), 0)::text AS qty,
      COALESCE(SUM(price * qty), 0)::text AS notional,
      (COUNT(*) FILTER (WHERE fee_asset IS NULL OR btrim(fee_asset) = '' OR fee_amount IS NULL))::int AS fee_missing
    FROM trade.fills
    WHERE user_id = ${userId}::uuid AND order_id = ANY(${ids}::uuid[])
  `;
  const row = sums[0];
  if (!row || row.n === 0) return null;
  let fees: Map<string, Amount> | null = null;
  if (row.fee_missing === 0) {
    const feeRows = await sql<Array<{ asset: string; amount: string }>>`
      SELECT btrim(fee_asset) AS asset, SUM(fee_amount)::text AS amount
      FROM trade.fills
      WHERE user_id = ${userId}::uuid AND order_id = ANY(${ids}::uuid[])
      GROUP BY btrim(fee_asset)
    `;
    fees = new Map(feeRows.map((r) => [r.asset, parseAmount(r.amount)]));
  }
  return { quoteAsset, filledQty: parseAmount(row.qty), notional36: parseScale36(row.notional), fees };
}
