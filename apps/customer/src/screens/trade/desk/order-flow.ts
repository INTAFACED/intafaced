/**
 * Order flow on the desk (J-charts-desk-14, C-trade-dom-01): the DOM ladder, time and sales filters and the depth curve.
 * Pure arithmetic over the book and tape the desk already reads. Prices and amounts stay decimal strings on the way in
 * and out; sums are scaled bigint (order-math `scaled`), so no float ever touches a price or an amount. The depth
 * curve's drawing coordinates are the only numbers, and they are pixels, never money.
 */
import type { OrderBook, Trade } from '@intafaced/exchange-contract/schemas';
import { groupLevels, type RawLevel } from './book-math';
import { formatAmount } from '../../../shared/money';
import { scaled } from './order-math';
import type { QueuePosition } from '../../../features/trade/trade-api';

const unscale = (units: bigint): string => formatAmount(units);

/** The ladder's columns: single shows one working-orders column, double one for my bids and one for my asks. */
export type LadderColumns = 'single' | 'double';
/** Price steps the ladder offers, in ticks of the market. The smallest is one tick: a step below the tick is refused. */
export const LADDER_STEPS = [1, 2, 5, 10, 25, 100] as const;
export type LadderStep = (typeof LADDER_STEPS)[number];
export type TapeUnits = 'base' | 'quote';

/** What the DOM keeps per device: open or not, and its ladder and tape settings. The symbol is never kept: it is the chart's. */
export interface DomSetting {
  open: boolean;
  columns: LadderColumns;
  stepTicks: LadderStep;
  /** The tape's minimum amount, as typed (a decimal string, or '' for none), in `units`. */
  minAmount: string;
  units: TapeUnits;
  accumulate: boolean;
}

export const DEFAULT_DOM: DomSetting = { open: false, columns: 'single', stepTicks: 1, minAmount: '', units: 'base', accumulate: false };

export function isDomSetting(value: unknown): value is DomSetting {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.open === 'boolean' &&
    (v.columns === 'single' || v.columns === 'double') &&
    (LADDER_STEPS as readonly unknown[]).includes(v.stepTicks) &&
    typeof v.minAmount === 'string' &&
    (v.minAmount === '' || scaled(v.minAmount) !== null) &&
    (v.units === 'base' || v.units === 'quote') &&
    typeof v.accumulate === 'boolean'
  );
}

/** The price step of `ticks` ticks, as a decimal string; null when the tick or the count is not a usable step. */
export function stepOf(tickSize: string, ticks: number): string | null {
  const tick = scaled(tickSize);
  if (tick === null || tick <= 0n || !Number.isInteger(ticks) || ticks < 1) return null;
  return unscale(tick * BigInt(ticks));
}

export interface LadderRow {
  price: string;
  /** Resting size on the bid at this bucket, '' when none. */
  bid: string;
  /** Resting size on the ask at this bucket, '' when none. */
  ask: string;
  /** My own working size at this bucket (buy and sell), '' when none. */
  myBid: string;
  myAsk: string;
  best: 'bid' | 'ask' | null;
}

export interface Ladder {
  rows: LadderRow[];
  /** Highest price first. */
  bestBid: string | null;
  bestAsk: string | null;
  /** Total size on each side over every level of the book (grouping never changes it). */
  bidTotal: string;
  askTotal: string;
}

export interface WorkingOrder {
  side: 'buy' | 'sell';
  price: string | null | undefined;
  remaining: string;
}

/**
 * The ladder: every bucket of the book at the step, one row a price, highest first, with my working orders beside the
 * book's sizes. Bids round down and asks round up, so a bucket never shows a better price than its orders have.
 */
export function buildLadder(
  book: Pick<OrderBook, 'bids' | 'asks'>,
  step: string,
  mine: readonly WorkingOrder[] = [],
  rowsPerSide = 200,
): Ladder {
  const bids = groupLevels(book.bids as readonly RawLevel[], 'bid', step).slice(0, rowsPerSide);
  const asks = groupLevels(book.asks as readonly RawLevel[], 'ask', step).slice(0, rowsPerSide);
  const stepUnits = scaled(step) ?? 0n;
  const bucket = (price: bigint, side: 'bid' | 'ask') => {
    if (stepUnits <= 0n) return price;
    const floor = (price / stepUnits) * stepUnits;
    return side === 'bid' || floor === price ? floor : floor + stepUnits;
  };
  const rows = new Map<bigint, { bid: bigint; ask: bigint; myBid: bigint; myAsk: bigint }>();
  const at = (price: bigint) => {
    let row = rows.get(price);
    if (!row) rows.set(price, (row = { bid: 0n, ask: 0n, myBid: 0n, myAsk: 0n }));
    return row;
  };
  for (const level of bids) at(level.price).bid += level.amount;
  for (const level of asks) at(level.price).ask += level.amount;
  for (const order of mine) {
    const price = order.price ? scaled(order.price) : null;
    const left = scaled(order.remaining);
    if (price === null || left === null || left <= 0n) continue;
    const row = at(bucket(price, order.side === 'buy' ? 'bid' : 'ask'));
    if (order.side === 'buy') row.myBid += left;
    else row.myAsk += left;
  }
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const text = (units: bigint) => (units > 0n ? unscale(units) : '');
  const sorted = [...rows.entries()].sort(([a], [b]) => (a === b ? 0 : a > b ? -1 : 1));
  const sum = (levels: readonly RawLevel[]) => levels.reduce((total, [, amount]) => total + (scaled(amount) ?? 0n), 0n);
  return {
    rows: sorted.map(([price, row]) => ({
      price: unscale(price),
      bid: text(row.bid),
      ask: text(row.ask),
      myBid: text(row.myBid),
      myAsk: text(row.myAsk),
      best: price === bestBid ? 'bid' : price === bestAsk ? 'ask' : null,
    })),
    bestBid: bestBid === null ? null : unscale(bestBid),
    bestAsk: bestAsk === null ? null : unscale(bestAsk),
    bidTotal: unscale(sum(book.bids as readonly RawLevel[])),
    askTotal: unscale(sum(book.asks as readonly RawLevel[])),
  };
}

export interface TapeRow {
  id: string;
  timestamp: number;
  side: 'buy' | 'sell';
  price: string;
  /** Base amount. */
  amount: string;
  /** Quote value (price times amount). */
  value: string;
  /** How many prints this row stands for (more than one when accumulated at its price). */
  prints: number;
  /** Bar width in permille of the largest row shown, in the chosen units. */
  bar: string;
}

export interface TapeView {
  rows: TapeRow[];
  /** Prints hidden because they are below the minimum. */
  hidden: number;
  /** Every print read. */
  total: number;
}

const mulUnits = (a: bigint, b: bigint) => (a * b) / 10n ** 18n;

/**
 * Time and sales: newest first; prints below the minimum (in base or quote units) are hidden and counted; with
 * `accumulate`, consecutive prints at the same price and side add up into one row. A minimum that is not a decimal hides
 * nothing (the field says why).
 */
export function tapeView(
  trades: readonly Trade[],
  options: { minAmount: string; units: TapeUnits; accumulate: boolean; limit?: number },
): TapeView {
  const min = options.minAmount.trim() === '' ? 0n : (scaled(options.minAmount.trim()) ?? 0n);
  const sorted = [...trades].sort((a, b) => b.timestamp - a.timestamp);
  const kept: Array<Omit<TapeRow, 'bar' | 'amount' | 'value'> & { amount: bigint; value: bigint }> = [];
  let hidden = 0;
  for (const trade of sorted) {
    const amount = scaled(trade.amount);
    const price = scaled(trade.price);
    if (amount === null || price === null) continue;
    const value = mulUnits(amount, price);
    if ((options.units === 'base' ? amount : value) < min) {
      hidden += 1;
      continue;
    }
    const last = kept[kept.length - 1];
    if (options.accumulate && last && last.price === trade.price && last.side === trade.side) {
      last.amount += amount;
      last.value += value;
      last.prints += 1;
      continue;
    }
    kept.push({ id: trade.id, timestamp: trade.timestamp, side: trade.side, price: trade.price, amount, value, prints: 1 });
  }
  const rows = kept.slice(0, options.limit ?? 50);
  const size = (row: { amount: bigint; value: bigint }) => (options.units === 'base' ? row.amount : row.value);
  const widest = rows.reduce((max, row) => (size(row) > max ? size(row) : max), 0n);
  return {
    rows: rows.map((row) => ({
      ...row,
      amount: unscale(row.amount),
      value: unscale(row.value),
      bar: widest > 0n ? ((size(row) * 1000n) / widest).toString() : '0',
    })),
    hidden,
    total: sorted.length,
  };
}

export interface DepthPoint {
  price: string;
  /** Cumulative size from the best price out to this level, in base units. */
  cumulative: string;
  /** The same in quote units. */
  cumulativeValue: string;
}

export interface DepthCurve {
  bids: DepthPoint[];
  asks: DepthPoint[];
  bidTotal: string;
  askTotal: string;
}

/** The depth curve: cumulative size outward from the best bid and the best ask, one point per level of the book. */
export function depthCurve(book: Pick<OrderBook, 'bids' | 'asks'>): DepthCurve {
  const side = (levels: readonly RawLevel[]) => {
    let running = 0n;
    let runningValue = 0n;
    const points: DepthPoint[] = [];
    for (const [priceText, amountText] of levels) {
      const price = scaled(priceText);
      const amount = scaled(amountText);
      if (price === null || amount === null || amount <= 0n) continue;
      running += amount;
      runningValue += mulUnits(price, amount);
      points.push({ price: unscale(price), cumulative: unscale(running), cumulativeValue: unscale(runningValue) });
    }
    return { points, total: unscale(running) };
  };
  const bids = side(book.bids as readonly RawLevel[]);
  const asks = side(book.asks as readonly RawLevel[]);
  return { bids: bids.points, asks: asks.points, bidTotal: bids.total, askTotal: asks.total };
}

/** The spread between the best ask and the best bid, as a decimal string; null without both, or on a crossed book. */
export function spreadOf(bestBid: string | null, bestAsk: string | null): string | null {
  const bid = bestBid === null ? null : scaled(bestBid);
  const ask = bestAsk === null ? null : scaled(bestAsk);
  if (bid === null || ask === null || ask < bid) return null;
  return unscale(ask - bid);
}

/**
 * What the DOM says about one resting order's place in the queue. The chance is shown only when the service sent both
 * the estimate and its basis (the owner's window is set); otherwise the readout is "not set" and holds no percent.
 */
export type QueueReadout = {
  readonly ahead:
    | { readonly kind: 'first' }
    | { readonly kind: 'one'; readonly size: string }
    | { readonly kind: 'many'; readonly n: number; readonly size: string };
  readonly chance:
    | {
        readonly kind: 'estimate';
        readonly ratio: string;
        readonly windowSeconds: number;
        readonly tradedThrough: string;
        readonly sizeToFill: string;
      }
    | { readonly kind: 'unset' };
};

export function queueReadout(q: QueuePosition): QueueReadout {
  const ahead: QueueReadout['ahead'] =
    q.ordersAhead === 0
      ? { kind: 'first' }
      : q.ordersAhead === 1
        ? { kind: 'one', size: q.sizeAhead }
        : { kind: 'many', n: q.ordersAhead, size: q.sizeAhead };
  const basis = q.fillProbabilityBasis;
  const chance: QueueReadout['chance'] =
    q.fillProbability !== undefined && basis !== undefined
      ? {
          kind: 'estimate',
          ratio: q.fillProbability,
          windowSeconds: basis.windowSeconds,
          tradedThrough: basis.tradedThrough,
          sizeToFill: basis.sizeToFill,
        }
      : { kind: 'unset' };
  return { ahead, chance };
}
