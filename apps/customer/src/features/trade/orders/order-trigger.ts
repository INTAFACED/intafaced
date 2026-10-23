import { dec, ratio, str, sub } from '../../../data/decimal';
import type { Order } from '../trade-api';

/**
 * A stop order's trigger as the order page reads it (J-cex-spot-06 #6): whether it fired, when and at what price, and
 * how far the fills landed from the stop price. Pure: the page only words it.
 */
export type TriggerState =
  | { readonly kind: 'not-stop' }
  /** The wire says nothing (an older service): the page says "not stated", never "waiting". */
  | { readonly kind: 'not-stated'; readonly stopPrice: string }
  | { readonly kind: 'waiting'; readonly stopPrice: string }
  /** Ended without firing, or fired with no record kept: the page does not guess which. */
  | { readonly kind: 'not-recorded'; readonly stopPrice: string }
  | {
      readonly kind: 'fired';
      readonly stopPrice: string;
      readonly at: string;
      readonly by: 'last' | 'mark' | 'index';
      readonly referencePrice: string;
      readonly slippage: Slippage | null;
    };

/** How far the average fill landed from the stop price, against the person: positive is worse, negative better. */
export interface Slippage {
  readonly amount: string;
  /** Fraction of the stop price, as a rate ("0.005" is 0.5%). */
  readonly rate: string;
}

export function slippageOf(side: Order['side'], stopPrice: string, average: string | null): Slippage | null {
  const stop = dec(stopPrice);
  const avg = dec(average);
  if (stop === null || avg === null || stop <= 0n) return null;
  // A sell stop is worse when it filled below the stop; a buy stop when it filled above.
  const worse = side === 'sell' ? sub(stop, avg) : sub(avg, stop);
  const rate = ratio(worse, stop);
  return rate === null ? null : { amount: str(worse), rate: str(rate) };
}

export function orderTrigger(order: Order, terminal: boolean): TriggerState {
  if (order.type !== 'stop_limit' || !order.stopPrice) return { kind: 'not-stop' };
  const stopPrice = order.stopPrice;
  if (order.triggered === undefined) return { kind: 'not-stated', stopPrice };
  if (order.triggered === null) return terminal ? { kind: 'not-recorded', stopPrice } : { kind: 'waiting', stopPrice };
  const fired = order.triggered;
  return {
    kind: 'fired',
    stopPrice,
    at: fired.at,
    by: fired.by,
    referencePrice: fired.referencePrice,
    slippage: (dec(order.filled) ?? 0n) > 0n ? slippageOf(order.side, stopPrice, order.average) : null,
  };
}
