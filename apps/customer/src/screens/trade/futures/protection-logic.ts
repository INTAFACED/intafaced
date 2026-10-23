/**
 * A position's take-profit and stop-loss (J-derivatives-03, D-orders-05): which legs to show, and the estimated result
 * at a price. Pure, so the rules are tested without a screen. Money stays exact decimal strings; unknown is null.
 */
import type { Position } from '@intafaced/exchange-contract/schemas';
import { dec, str, sub, times } from '../../../data/decimal';
import type { ConditionalOrder } from './api';

export type Leg = 'take_profit' | 'stop_loss';

const LIVE = new Set<ConditionalOrder['status']>(['armed', 'triggered']);

/**
 * The leg to show for each side of the pair: the live one when there is one, otherwise the most recent that finished,
 * so a fired or cancelled leg stays readable until a new one is set.
 */
export function legsOf(orders: readonly ConditionalOrder[], positionId: string | null): Record<Leg, ConditionalOrder | null> {
  const pick = (leg: Leg) => {
    const mine = orders.filter((o) => o.positionId === positionId && o.attachment === leg);
    const live = mine.filter((o) => LIVE.has(o.status));
    const pool = live.length > 0 ? live : mine;
    return pool.reduce<ConditionalOrder | null>((latest, o) => (latest === null || o.createdAt > latest.createdAt ? o : latest), null);
  };
  return positionId === null ? { take_profit: null, stop_loss: null } : { take_profit: pick('take_profit'), stop_loss: pick('stop_loss') };
}

export function isLive(order: ConditionalOrder | null): boolean {
  return order !== null && LIVE.has(order.status);
}

/**
 * The result if the position (or `quantity` of it) closed at `price`, before fees: (price − entry) × size, negated for
 * a short. A position's size is in the base asset, as its notional and unrealised PnL are worked out. Null when any
 * input is unknown or malformed: never a guessed figure.
 */
export function estimatedResult(position: Position, price: string, quantity?: string | null): string | null {
  const at = dec(price);
  const entry = dec(position.entryPrice);
  const size = quantity ? dec(quantity) : dec(position.contracts);
  if (at === null || at <= 0n || entry === null || size === null) return null;
  const move = position.side === 'long' ? sub(at, entry) : sub(entry, at);
  return str(times(move, size));
}

/** Which side of the mark each leg must sit on, for the field hint. Null when the side is unknown. */
export function sideOfMark(position: Position, leg: Leg): 'above' | 'below' | null {
  if (position.side !== 'long' && position.side !== 'short') return null;
  const up = (position.side === 'long') === (leg === 'take_profit');
  return up ? 'above' : 'below';
}

/** A part leg's size: empty is the whole position; otherwise above zero and at most the position. */
export function partProblem(value: string, contracts: string): 'invalid' | 'overPosition' | null {
  if (value.trim() === '') return null;
  const parsed = dec(value.trim());
  if (parsed === null || parsed <= 0n) return 'invalid';
  const held = dec(contracts);
  return held !== null && parsed > held ? 'overPosition' : null;
}

/** What a leg covers: the whole position, or its own size and what is left beside it. Null when not readable. */
export function coverage(
  order: ConditionalOrder,
  contracts: string,
): { whole: true } | { whole: false; part: string; rest: string } | null {
  if (order.wholePosition !== false) return { whole: true };
  const part = dec(order.quantity);
  const held = dec(contracts);
  if (part === null || held === null) return null;
  return { whole: false, part: order.quantity, rest: str(held > part ? sub(held, part) : 0n) };
}

/** A price field's problem before anything is sent. Empty is allowed: it clears that leg. */
export function priceProblem(value: string): 'invalid' | null {
  if (value.trim() === '') return null;
  const parsed = dec(value.trim());
  return parsed === null || parsed <= 0n ? 'invalid' : null;
}
