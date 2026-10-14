/**
 * Scale order arithmetic (ticket v2): N limit orders across a price range, size spread evenly or weighted.
 *
 * Everything is a decimal string in and out and bigint in between (18 places, `parseAmount`). No float anywhere.
 * The plan never rounds an order up past what the person asked for: the amounts always add up to exactly the total
 * they typed, and every order sits on the market's price step and amount step. If the plan cannot be made to fit the
 * market's rules it is refused with the reason; it is never quietly changed.
 */
import { mul } from '@intafaced/ledger-client/money';
import { formatAmount } from '../../../../shared/money';
import type { DeskMarket } from '../market';
import { scaled, type Side } from '../order-math';

export const SCALE_MIN_ORDERS = 2;
/** The service takes up to 100 in one batch; 20 keeps the review readable and the checks quick. */
export const SCALE_MAX_ORDERS = 20;

export type Spread = 'even' | 'weighted';

export interface ScaleInput {
  side: Side;
  /** The first order's price (the one nearest where you want to start). */
  from: string;
  /** The last order's price (the farthest). */
  to: string;
  /** Whole number of orders as typed. */
  count: string;
  /** Total amount of the base asset across all orders. */
  total: string;
  spread: Spread;
}

export interface ScaleRow {
  price: string;
  amount: string;
  /** price x amount in the quote asset, floored. */
  value: string;
}

export type ScaleProblem =
  | { kind: 'count'; min: number; max: number }
  | { kind: 'priceEmpty' }
  | { kind: 'priceTick'; tick: string }
  | { kind: 'samePrice' }
  | { kind: 'tooNarrow'; count: number }
  | { kind: 'amountEmpty' }
  | { kind: 'amountLot'; lot: string }
  | { kind: 'tooSmall'; count: number; lot: string }
  | { kind: 'amountMin'; min: string }
  | { kind: 'valueMin'; min: string };

export type ScalePlan = { ok: true; rows: ScaleRow[]; totalAmount: string; totalValue: string } | { ok: false; problem: ScaleProblem };

const positive = (value: string | null | undefined): bigint | null => {
  const parsed = scaled(value);
  return parsed !== null && parsed > 0n ? parsed : null;
};

/** Floor division that rounds toward minus infinity (bigint `/` truncates toward zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** The whole number of orders, or null when the text is not a plain whole number inside the allowed range. */
export function parseCount(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const count = Number.parseInt(text.trim(), 10);
  return count >= SCALE_MIN_ORDERS && count <= SCALE_MAX_ORDERS ? count : null;
}

/** Size of each order in whole lots. Even: equal shares. Weighted: 1, 2, 3 ... N from the first price to the last. */
export function splitLots(totalLots: bigint, count: number, spread: Spread): bigint[] {
  const weights = Array.from({ length: count }, (_, i) => (spread === 'even' ? 1n : BigInt(i + 1)));
  const weightSum = weights.reduce((sum, w) => sum + w, 0n);
  const lots = weights.map((w) => (totalLots * w) / weightSum);
  // The floors lose less than one lot each. Hand the leftovers out one by one from the last (farthest) order back,
  // so the amounts add up to exactly the total.
  let left = totalLots - lots.reduce((sum, l) => sum + l, 0n);
  for (let i = count - 1; left > 0n; i = i === 0 ? count - 1 : i - 1) {
    lots[i] = lots[i]! + 1n;
    left -= 1n;
  }
  return lots;
}

export function planScale(input: ScaleInput, market: Pick<DeskMarket, 'tickSize' | 'lotSize' | 'minAmount' | 'minCost'>): ScalePlan {
  const count = parseCount(input.count);
  if (count === null) return { ok: false, problem: { kind: 'count', min: SCALE_MIN_ORDERS, max: SCALE_MAX_ORDERS } };

  const from = positive(input.from);
  const to = positive(input.to);
  if (from === null || to === null) return { ok: false, problem: { kind: 'priceEmpty' } };
  const tick = positive(market.tickSize);
  if (tick === null || from % tick !== 0n || to % tick !== 0n) return { ok: false, problem: { kind: 'priceTick', tick: market.tickSize } };
  if (from === to) return { ok: false, problem: { kind: 'samePrice' } };

  const total = positive(input.total);
  if (total === null) return { ok: false, problem: { kind: 'amountEmpty' } };
  const lot = positive(market.lotSize);
  if (lot === null || total % lot !== 0n) return { ok: false, problem: { kind: 'amountLot', lot: market.lotSize } };
  const totalLots = total / lot;
  if (totalLots < BigInt(count)) return { ok: false, problem: { kind: 'tooSmall', count, lot: market.lotSize } };

  // Prices: equal steps from the first to the last, each rounded to the nearest price step (half up).
  const fromTicks = from / tick;
  const span = to / tick - fromTicks;
  const gaps = BigInt(count - 1);
  const prices: bigint[] = [];
  for (let i = 0; i < count; i += 1) {
    const offset = floorDiv(span * BigInt(i) * 2n + gaps, gaps * 2n);
    const price = (fromTicks + offset) * tick;
    if (prices.length > 0 && price === prices[prices.length - 1]) return { ok: false, problem: { kind: 'tooNarrow', count } };
    prices.push(price);
  }

  const lots = splitLots(totalLots, count, input.spread);
  const minAmount = positive(market.minAmount);
  const minCost = positive(market.minCost);
  let totalValue = 0n;
  const rows: ScaleRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const price = prices[i]!;
    if (lots[i]! <= 0n) return { ok: false, problem: { kind: 'tooSmall', count, lot: market.lotSize } };
    const amount = lots[i]! * lot;
    if (minAmount !== null && amount < minAmount) return { ok: false, problem: { kind: 'amountMin', min: market.minAmount! } };
    const value = mul(price, amount, 'floor');
    if (minCost !== null && value < minCost) return { ok: false, problem: { kind: 'valueMin', min: market.minCost! } };
    totalValue += value;
    rows.push({ price: formatAmount(price), amount: formatAmount(amount), value: formatAmount(value) });
  }
  return { ok: true, rows, totalAmount: formatAmount(total), totalValue: formatAmount(totalValue) };
}

/**
 * Orders that would trade the moment they arrive, judged against the book the person sees (advisory: the service
 * decides). A buy at or above the best ask, or a sell at or below the best bid, takes liquidity instead of resting.
 */
export function crossingCount(
  side: Side,
  rows: readonly ScaleRow[],
  ref: { bestBid: string | null; bestAsk: string | null } | null,
): number {
  if (!ref) return 0;
  const edge = scaled(side === 'buy' ? ref.bestAsk : ref.bestBid);
  if (edge === null) return 0;
  return rows.filter((row) => {
    const price = scaled(row.price);
    if (price === null) return false;
    return side === 'buy' ? price >= edge : price <= edge;
  }).length;
}

/** What the plan spends from the balance if every order rests: a buy holds price x amount, a sell holds the base amount. */
export function planHold(side: Side, plan: Extract<ScalePlan, { ok: true }>): string {
  return side === 'buy' ? plan.totalValue : plan.totalAmount;
}
