/**
 * My place in the queue, and the estimated chance a resting order fills (J-charts-desk-14 #8, RC-charts-desk-01).
 *
 *   GET /api/v1/orders/:id/queue   (trade:read, the caller's own open limit order)
 *
 * - The place comes from matching's native per-order queue (`GET /markets/:id/depth/l3`), never from L2 sizes: the
 *   orders ahead are those at the order's own price and side with a lower engine sequence. The answer gives only their
 *   count and summed remaining size; no other maker's id or size leaves this service.
 * - The chance is an estimate, served only while the owner has set its window (`queueFillWindowSeconds`, charts owner
 *   values, C-ops-04). It is the base traded at or through the order's price over that window, divided by the size that
 *   must trade before the order is done (the size ahead plus the order's own remaining), capped at 1. While the window is
 *   blank the field is null with `trade.queue_probability_unset`, never a default percent.
 * - Refusals: another person's order or an unknown id `trade.order_not_found` (no existence leak); not a resting limit
 *   order `trade.order_not_open`; matching without L3 for the market `trade.l3_unavailable`; matching unreachable, or the
 *   order not in its queue, `trade.queue_unavailable`. A read only: nothing is held, posted or sent.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import { toCcxtError, type CcxtErrorResponse } from '../ccxt-errors.js';
import { privateRead } from '../route-inventory.js';
import type { OrderRecord, PublicTapePrint } from './types.js';

export const QUEUE_PROBABILITY_UNSET = 'trade.queue_probability_unset' as const;
export const QUEUE_UNAVAILABLE = 'trade.queue_unavailable' as const;
export const QUEUE_L3_UNAVAILABLE = 'trade.l3_unavailable' as const;
export const QUEUE_ORDER_NOT_OPEN = 'trade.order_not_open' as const;

/** Matching's L3 answer, as `GET /markets/:id/depth/l3` sends it. */
export interface L3Answer {
  readonly level?: string | null;
  readonly accepted?: boolean;
  readonly bids?: ReadonlyArray<{ price: string; orders: ReadonlyArray<{ orderId: string; remaining: string; sequence: number }> }>;
  readonly asks?: ReadonlyArray<{ price: string; orders: ReadonlyArray<{ orderId: string; remaining: string; sequence: number }> }>;
  readonly rejected?: { code: string; message: string } | null;
}

export interface QueuePositionView {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly price: string;
  readonly remaining: string;
  /** Orders ahead of this one at its price and side. */
  readonly ordersAhead: number;
  /** Their summed remaining size, in the base asset. */
  readonly sizeAhead: string;
  /** This order's own engine sequence at its level. */
  readonly sequence: number;
  readonly source: 'native_l3';
  readonly asOf: string;
  /** The estimate, a decimal string from 0 to 1; null while the owner window is blank. */
  readonly fillProbability: string | null;
  readonly fillProbabilityRefusal: typeof QUEUE_PROBABILITY_UNSET | null;
  /** The window the estimate is over, in seconds; null while it is blank. */
  readonly windowSeconds: number | null;
  /** Base traded at or through the price over the window; null while the window is blank. */
  readonly tradedInWindow: string | null;
}

export class QueueReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const ONE = parseAmount('1');

/** The place of `orderId` in its level of the native queue: orders ahead, their size, and its own sequence. */
export function placeInQueue(
  l3: L3Answer,
  order: Pick<OrderRecord, 'id' | 'side' | 'price'>,
): { ordersAhead: number; sizeAhead: Amount; sequence: number; remaining: Amount } {
  if (l3.accepted === false || l3.level !== 'L3') {
    throw new QueueReadError(QUEUE_L3_UNAVAILABLE, l3.rejected?.message ?? 'matching serves no native queue for this market', 404);
  }
  if (order.price === null) throw new QueueReadError(QUEUE_ORDER_NOT_OPEN, 'only a resting limit order has a place in the queue', 409);
  const levels = order.side === 'buy' ? (l3.bids ?? []) : (l3.asks ?? []);
  const level = levels.find((row) => parseAmount(row.price) === order.price);
  const mine = level?.orders.find((row) => row.orderId === order.id);
  if (!level || !mine) throw new QueueReadError(QUEUE_UNAVAILABLE, 'the order is not in the matching queue at its price', 503);
  let ordersAhead = 0;
  let sizeAhead = 0n;
  for (const row of level.orders) {
    if (row.sequence < mine.sequence) {
      ordersAhead += 1;
      sizeAhead += parseAmount(row.remaining);
    }
  }
  return { ordersAhead, sizeAhead, sequence: mine.sequence, remaining: parseAmount(mine.remaining) };
}

/**
 * The estimated chance: base traded at or through the order's price (a buy fills when the market trades at its price or
 * lower, a sell at its price or higher) over the window, over the size that must trade first plus its own, capped at 1.
 */
export function fillEstimate(
  side: 'buy' | 'sell',
  price: Amount,
  prints: readonly Pick<PublicTapePrint, 'price' | 'qty'>[],
  sizeAhead: Amount,
  remaining: Amount,
): { probability: string; traded: Amount } {
  let traded = 0n;
  for (const print of prints) if (side === 'buy' ? print.price <= price : print.price >= price) traded += print.qty;
  const needed = sizeAhead + remaining;
  if (needed <= 0n) return { probability: '1', traded };
  // Scaled ratio, 18 places, floored; never a float.
  const ratio = (traded * ONE) / needed;
  return { probability: formatAmount(ratio > ONE ? ONE : ratio), traded };
}

export interface QueuePositionDeps {
  readonly getOrder: (principal: Principal, orderId: string) => Promise<OrderRecord>;
  readonly marketById: (marketId: string) => Promise<{ id: string; symbol: string } | null>;
  readonly l3: (marketId: string) => Promise<L3Answer>;
  readonly tapeSince: (marketId: string, sinceMs: number) => Promise<readonly PublicTapePrint[]>;
  /** The owner's window, in seconds, or null while it is blank. */
  readonly windowSeconds: () => Promise<number | null>;
  readonly now: () => Date;
}

export async function readQueuePosition(deps: QueuePositionDeps, principal: Principal, orderId: string): Promise<QueuePositionView> {
  const order = await deps.getOrder(principal, orderId);
  if (order.status !== 'open' || order.type !== 'limit' || order.price === null) {
    throw new QueueReadError(QUEUE_ORDER_NOT_OPEN, `order ${orderId} is not a resting limit order`, 409);
  }
  const market = await deps.marketById(order.marketId);
  let l3: L3Answer;
  try {
    l3 = await deps.l3(order.marketId);
  } catch (err) {
    if (err instanceof QueueReadError) throw err;
    throw new QueueReadError(QUEUE_UNAVAILABLE, 'the matching queue could not be read', 503);
  }
  const place = placeInQueue(l3, order);
  const at = deps.now();
  const window = await deps.windowSeconds();
  let fillProbability: string | null = null;
  let tradedInWindow: string | null = null;
  if (window !== null) {
    const prints = await deps.tapeSince(order.marketId, at.getTime() - window * 1000);
    const estimate = fillEstimate(order.side, order.price, prints, place.sizeAhead, place.remaining);
    fillProbability = estimate.probability;
    tradedInWindow = formatAmount(estimate.traded);
  }
  return {
    orderId: order.id,
    symbol: market?.symbol ?? order.marketId,
    side: order.side,
    price: formatAmount(order.price),
    remaining: formatAmount(place.remaining),
    ordersAhead: place.ordersAhead,
    sizeAhead: formatAmount(place.sizeAhead),
    sequence: place.sequence,
    source: 'native_l3',
    asOf: at.toISOString(),
    fillProbability,
    fillProbabilityRefusal: window === null ? QUEUE_PROBABILITY_UNSET : null,
    windowSeconds: window,
    tradedInWindow,
  };
}

const sendCcxt = (reply: FastifyReply, res: CcxtErrorResponse) => reply.code(res.status).send(res.body);

function refusal(err: QueueReadError): CcxtErrorResponse {
  const ccxt = err.status === 409 ? 'InvalidOrder' : err.status === 404 ? 'NotSupported' : 'ExchangeNotAvailable';
  return { status: err.status, body: { code: ccxt, message: err.message, intafacedCode: err.code } };
}

export function attachQueuePositionRoute(
  app: FastifyInstance,
  deps: QueuePositionDeps | undefined,
  requirePrincipal: (req: FastifyRequest, reply: FastifyReply) => Principal | null,
): void {
  if (!deps) return;
  app.get<{ Params: { id: string } }>('/api/v1/orders/:id/queue', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    try {
      return reply.code(200).send(await readQueuePosition(deps, principal, req.params.id));
    } catch (err) {
      if (err instanceof QueueReadError) return sendCcxt(reply, refusal(err));
      const mapped = toCcxtError(err);
      if (mapped) return sendCcxt(reply, mapped);
      throw err;
    }
  });
}
