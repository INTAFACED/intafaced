/**
 * My place in the queue (RC-charts-desk-01, J-charts-desk-14 #8): where one of the caller's own resting limit orders
 * stands in the native matching queue at its price, and, only when the owner has set a window, an estimated chance of
 * a fill.
 *
 * Position is a fact from matching's per-order L3 queue (`GET /markets/:id/depth/l3`): the orders at the same price on
 * the same side with a lower acceptance sequence are ahead, and their remaining sizes add up to the size ahead. Other
 * makers' order ids and single sizes are counted here and never returned: only the count and the sum leave.
 *
 * The estimate is one documented method, `traded_through_window`: the volume that traded at or through this order's
 * price over the owner's window (`queueFillWindowSeconds`, charts owner values), divided by the size that has to trade
 * for this order to fill completely (the size ahead plus its own remaining size), capped at 1, floored to 4 places. It
 * reads: "if the next window trades as the last one did at this price, this share of the queue up to and including me
 * would be cleared." It is a ratio from recent prints, not a model; with the window blank there is no estimate at all,
 * and the answer says so with `trade.queue_probability_unset`, never a default percent.
 *
 * Nothing here is computed from L2 aggregates, and nothing here moves money: a read only.
 */
import type { Principal } from '@intafaced/auth';
import { div, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { MatchingUnavailableError, type EngineL3Queue } from './matching-client.js';
import { TradeError, type OrderRecord, type OrderSide } from './types.js';

export const QUEUE_FILL_METHOD = 'traded_through_window' as const;
export const TRADE_QUEUE_PROBABILITY_UNSET = 'trade.queue_probability_unset' as const;
export const QUEUE_PROBABILITY_UNSET_MESSAGE =
  'the owner has not set the queue fill window, so no chance of a fill is estimated; the queue position stands alone';

/** Places of the estimate. A ratio, not money: 4 places is 0.01 percent. */
const ESTIMATE_PLACES = 4n;
const ONE = parseAmount('1');
const ESTIMATE_STEP = 10n ** (18n - ESTIMATE_PLACES);

export interface QueuePlace {
  readonly ordersAhead: number;
  readonly sizeAhead: Amount;
  /** This order's own remaining size in the queue, as matching holds it. */
  readonly remaining: Amount;
}

/**
 * Where `orderId` stands at `price` on `side` in the native queue, or null when the queue does not hold it at that price
 * (it is not resting: filled, cancelled or not yet in the book).
 */
export function placeInQueue(queue: EngineL3Queue, side: OrderSide, price: Amount, orderId: string): QueuePlace | null {
  const levels = side === 'buy' ? queue.bids : queue.asks;
  const level = levels.find((row) => parseAmount(row.price) === price);
  if (!level) return null;
  const mine = level.orders.find((row) => row.orderId === orderId);
  if (!mine) return null;
  let ordersAhead = 0;
  let sizeAhead = 0n;
  for (const row of level.orders) {
    if (row.orderId === orderId || row.sequence >= mine.sequence) continue;
    ordersAhead += 1;
    sizeAhead += parseAmount(row.remaining);
  }
  return { ordersAhead, sizeAhead, remaining: parseAmount(mine.remaining) };
}

/** The estimate as a decimal string in 0..1, floored to 4 places. `tradedThrough` is the window's volume at or through. */
export function fillEstimate(place: QueuePlace, tradedThrough: Amount): string {
  const toClear = place.sizeAhead + place.remaining;
  if (toClear <= 0n) return formatAmount(ONE);
  const ratio = tradedThrough >= toClear ? ONE : div(tradedThrough, toClear, 'floor');
  return formatAmount((ratio / ESTIMATE_STEP) * ESTIMATE_STEP);
}

export interface QueuePositionView {
  readonly orderId: string;
  readonly marketId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly price: string;
  readonly ordersAhead: number;
  readonly sizeAhead: string;
  readonly remaining: string;
  readonly asOfSequence: number;
  readonly source: 'native_l3';
  /** Present only with the owner's window set. */
  readonly fillProbability?: string;
  readonly fillProbabilityBasis?: {
    readonly method: typeof QUEUE_FILL_METHOD;
    readonly windowSeconds: number;
    /** Volume traded at or through this order's price in the window (public prints, the same rows as the tape). */
    readonly tradedThrough: string;
    /** Size ahead plus this order's remaining size: what has to trade for it to fill. */
    readonly sizeToFill: string;
  };
  /** Present only with the owner's window blank: why there is no estimate. */
  readonly fillProbabilityRefused?: { readonly code: typeof TRADE_QUEUE_PROBABILITY_UNSET; readonly message: string };
}

export function presentQueuePosition(input: {
  readonly orderId: string;
  readonly marketId: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly price: Amount;
  readonly place: QueuePlace;
  readonly asOfSequence: number;
  readonly estimate: { readonly windowSeconds: number; readonly tradedThrough: Amount } | null;
}): QueuePositionView {
  const { place } = input;
  const base = {
    orderId: input.orderId,
    marketId: input.marketId,
    symbol: input.symbol,
    side: input.side,
    price: formatAmount(input.price),
    ordersAhead: place.ordersAhead,
    sizeAhead: formatAmount(place.sizeAhead),
    remaining: formatAmount(place.remaining),
    asOfSequence: input.asOfSequence,
    source: 'native_l3' as const,
  };
  if (!input.estimate) {
    return { ...base, fillProbabilityRefused: { code: TRADE_QUEUE_PROBABILITY_UNSET, message: QUEUE_PROBABILITY_UNSET_MESSAGE } };
  }
  return {
    ...base,
    fillProbability: fillEstimate(place, input.estimate.tradedThrough),
    fillProbabilityBasis: {
      method: QUEUE_FILL_METHOD,
      windowSeconds: input.estimate.windowSeconds,
      tradedThrough: formatAmount(input.estimate.tradedThrough),
      sizeToFill: formatAmount(place.sizeAhead + place.remaining),
    },
  };
}

/** The engine's L3 page: the most levels a side matching answers (`parsePublicL2QueryLimit` 1..500). */
export const QUEUE_L3_LEVELS = 500;

export interface QueuePositionDeps {
  /** The caller's own order; another person's id throws `trade.order_not_found`, exactly as a missing one. */
  getOrder(principal: Principal, orderId: string): Promise<OrderRecord>;
  marketById(marketId: string): Promise<{ readonly symbol: string } | null>;
  l3Queue(marketId: string, limit: number): Promise<EngineL3Queue>;
  /** The owner's window in seconds, or null when blank. */
  queueFillWindowSeconds(): Promise<number | null>;
  tradedThrough(marketId: string, side: OrderSide, price: Amount, sinceMs: number): Promise<Amount>;
  now(): Date;
}

/**
 * The read behind `GET /api/v1/orders/:id/queue`. Refusals: not the caller's (or no such order) `trade.order_not_found`;
 * not a resting limit order, or not in the queue at its price any more `trade.order_not_open`; L3 not readable
 * `trade.queue_unavailable` (from the matching client; never an L2 fallback).
 */
export async function readQueuePosition(deps: QueuePositionDeps, principal: Principal, orderId: string): Promise<QueuePositionView> {
  const order = await deps.getOrder(principal, orderId);
  if (order.status !== 'open' || order.price === null) {
    throw new TradeError(`order ${orderId} is not resting in the book`, 'trade.order_not_open');
  }
  let queue: EngineL3Queue;
  try {
    queue = await deps.l3Queue(order.marketId, QUEUE_L3_LEVELS);
  } catch (err) {
    if (err instanceof MatchingUnavailableError) throw new TradeError(err.message, 'trade.queue_unavailable');
    throw err;
  }
  const place = placeInQueue(queue, order.side, order.price, order.id);
  if (!place) {
    // A full page that does not reach this price cannot prove absence: unavailable, not "not open".
    const side = order.side === 'buy' ? queue.bids : queue.asks;
    if (side.length >= QUEUE_L3_LEVELS) throw new TradeError(`order ${orderId} is past the queue page`, 'trade.queue_unavailable');
    throw new TradeError(`order ${orderId} is not resting in the book`, 'trade.order_not_open');
  }
  const market = await deps.marketById(order.marketId);
  const windowSeconds = await deps.queueFillWindowSeconds();
  const estimate =
    windowSeconds === null
      ? null
      : {
          windowSeconds,
          tradedThrough: await deps.tradedThrough(order.marketId, order.side, order.price, deps.now().getTime() - windowSeconds * 1000),
        };
  return presentQueuePosition({
    orderId: order.id,
    marketId: order.marketId,
    symbol: market?.symbol ?? order.marketId,
    side: order.side,
    price: order.price,
    place,
    asOfSequence: queue.sequence,
    estimate,
  });
}
