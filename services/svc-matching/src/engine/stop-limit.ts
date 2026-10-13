/**
 * Stop-limit through matching. It does not live on the book until the stop prints.
 * Refuse if stopPx is missing. The engine does not invent a trigger.
 */
import { ZERO, type Amount } from '@intafaced/ledger-client/money';
import type { OrderSide } from './types.js';

export const STOP_PX_MISSING = 'missing_stop_price' as const;

export type StopLimitRefuse = typeof STOP_PX_MISSING;

export function wantsStopLimit(order: { readonly type?: string }): boolean {
  return order.type === 'stop_limit';
}

/** Caller stopPx. Null/zero is missing — never invent a trigger. */
export function readStopPx(order: { readonly stopPx?: Amount | null; readonly stopPrice?: Amount | null }): Amount | null {
  if (order.stopPx !== undefined) return order.stopPx;
  if (order.stopPrice !== undefined) return order.stopPrice;
  return null;
}

export function stopPxRefuse(stopPx: Amount | null): { readonly code: StopLimitRefuse; readonly message: string } | null {
  if (stopPx === null || stopPx <= ZERO) {
    return {
      code: STOP_PX_MISSING,
      message: 'a stop_limit requires a stopPx; the engine does not invent a trigger',
    };
  }
  return null;
}

/**
 * True while the stop has not printed. lastTrade is the last print only —
 * never a mark, never a mid, never a best bid/ask.
 */
export function waitsOffBook(side: OrderSide, stopPx: Amount, lastTrade: Amount | null): boolean {
  if (lastTrade === null) return true;
  return side === 'buy' ? lastTrade < stopPx : lastTrade > stopPx;
}
