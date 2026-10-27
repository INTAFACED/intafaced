import { add, dec, ratio, str, sub, times } from '../../../data/decimal';
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
      /** `not-filled` before any fill; `unknown` when the fills' average is not known (yet). */
      readonly slippage: Slippage | 'not-filled' | 'unknown';
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

/**
 * The average price of an order's fills, from the fills the page read: Σ price × amount ÷ Σ amount. Null unless those
 * fills add up to exactly what the order says it filled (a cut or late list would give a wrong average).
 */
export function fillsAverage(fills: readonly { readonly price: string; readonly amount: string }[], filled: string): string | null {
  const want = dec(filled);
  if (want === null || want <= 0n) return null;
  let quote = 0n;
  let base = 0n;
  for (const fill of fills) {
    const price = dec(fill.price);
    const amount = dec(fill.amount);
    if (price === null || amount === null) return null;
    quote = add(quote, times(price, amount));
    base = add(base, amount);
  }
  if (base !== want) return null;
  const average = ratio(quote, base);
  return average === null ? null : str(average);
}

/** `average`: the order's average fill price, from the wire or from its fills; null when not known. */
export function orderTrigger(order: Order, terminal: boolean, average: string | null = order.average): TriggerState {
  if ((order.type !== 'stop_limit' && order.type !== 'stop') || !order.stopPrice) return { kind: 'not-stop' };
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
    slippage: (dec(order.filled) ?? 0n) > 0n ? (slippageOf(order.side, stopPrice, average) ?? 'unknown') : 'not-filled',
  };
}
