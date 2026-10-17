/**
 * Published TRADE_MAX_ORDER for spot notionals and futures size.
 *
 * Unset stays the credit mill's refusal (`trade.max_order_unset`). This module
 * compares an order to a published integer, including 0. It does not invent a cap.
 * Reduce-only spot orders are not refused here: shrinking a position is not new risk.
 */
import type { Principal } from '@intafaced/auth';
import { mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';

export const MAX_ORDER_EXCEEDED = 'trade.max_order_exceeded' as const;

export interface SpotCapOrder {
  readonly side: 'buy' | 'sell';
  readonly type: string;
  readonly qty: Amount;
  readonly price?: Amount | null;
  readonly reduceOnly?: boolean;
}

export interface SpotCapRefusal {
  readonly code: typeof MAX_ORDER_EXCEEDED;
  readonly reason: string;
}

/** Published integer, or null when unset / blank / not an integer. 0 is published. */
export function publishedMaxOrder(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const text = typeof raw === 'number' ? String(raw) : raw.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isInteger(value)) return null;
  return value;
}

function overCap(size: Amount, maxOrder: number): boolean {
  return size > parseAmount(String(maxOrder));
}

/**
 * Spot limit notional (price × qty) above the published max order.
 * Exactly the cap is allowed. A missing price is not a notional, so this returns null.
 */
export function spotCapRefusal(order: SpotCapOrder, maxOrderRaw: unknown): SpotCapRefusal | null {
  if (order.reduceOnly === true) return null;
  if (order.type !== 'limit' || order.price == null) return null;
  const maxOrder = publishedMaxOrder(maxOrderRaw);
  if (maxOrder == null) return null;
  const notional = mul(order.price, order.qty, 'floor');
  if (!overCap(notional, maxOrder)) return null;
  return {
    code: MAX_ORDER_EXCEEDED,
    reason: `spot order notional is above the published TRADE_MAX_ORDER of ${maxOrder}`,
  };
}

/** Futures size above the published max order. A published 0 refuses every positive size. */
export function futuresSizeOverPublishedMax(size: Amount, maxOrder: number): boolean {
  return overCap(size, maxOrder);
}

const PLACE_FLAG = Symbol.for('intafaced.trade.spotSizeCaps');

export function installSpotSizeCaps(ctor: typeof TradeService = TradeService, env: NodeJS.ProcessEnv = process.env): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<unknown>;
    [PLACE_FLAG]?: true;
  };
  if (proto[PLACE_FLAG]) return;
  proto[PLACE_FLAG] = true;
  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const refusal = spotCapRefusal(input as SpotCapOrder, env.TRADE_MAX_ORDER);
    if (refusal) throw new TradeError(refusal.reason, refusal.code);
    return origPlace.call(this, principal, input);
  };
}
