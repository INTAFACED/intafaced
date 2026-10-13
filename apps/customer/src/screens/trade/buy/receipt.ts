/**
 * What the success card says, read from the FILLS of the order, never from what was typed and never from the order's
 * own `cost`: for a market order the service sets `cost` from the reserved (protection) price, which is higher than
 * what was really paid (checked on the local stack: order cost 9.800889 against a real fill of 9.752127).
 * The fills are the ledger's record: their price, cost and fee are what moved. Until they can be read, the money rows
 * show "—" rather than a guess.
 */
import type { Trade } from '@intafaced/exchange-contract/schemas';
import type { Order } from './deps';
import { dec, divDown, str } from './trade-math';

export interface Receipt {
  side: 'buy' | 'sell';
  /** `filled`: all of it; `partial`: some; `none`: nothing moved; `open`: the service still shows it working. */
  status: 'filled' | 'partial' | 'none' | 'open';
  filled: string;
  amount: string;
  /** What was paid (buy) or received (sell), in the market's quote asset; null until the fills can be read. */
  cost: string | null;
  /** Cost per coin; null when unknown. */
  average: string | null;
  fee: { cost: string; currency: string } | null;
  orderId: string;
}

/** The fills that belong to this order, or null when none can be told apart (so nothing is invented). */
export function fillsOf(order: Pick<Order, 'id'>, fills: readonly Trade[] | null): Trade[] | null {
  const mine = (fills ?? []).filter((trade) => trade.order === order.id);
  return mine.length > 0 ? mine : null;
}

export function receiptFrom(order: Order, fills: readonly Trade[] | null = null): Receipt {
  const mine = fillsOf(order, fills);
  let filled = dec(order.filled) ?? 0n;
  let cost: bigint | null = null;
  let fee: Receipt['fee'] = order.fee && dec(order.fee.cost) !== null ? { cost: order.fee.cost, currency: order.fee.currency } : null;
  if (mine) {
    let amount = 0n;
    let sum = 0n;
    let known = true;
    for (const trade of mine) {
      const a = dec(trade.amount);
      const c = dec(trade.cost);
      if (a === null || c === null) known = false;
      else {
        amount += a;
        sum += c;
      }
    }
    if (known) {
      filled = amount;
      cost = sum;
    }
    // One fee line when every fill charged the same asset; otherwise leave it out rather than add unlike things.
    const charged = mine.filter((trade) => trade.fee && dec(trade.fee.cost) !== null);
    const currency = charged[0]?.fee?.currency;
    if (charged.length > 0 && charged.every((trade) => trade.fee?.currency === currency))
      fee = { cost: str(charged.reduce((total, trade) => total + (dec(trade.fee?.cost) ?? 0n), 0n)), currency: currency! };
  }
  const total = dec(order.amount) ?? 0n;
  const average = cost !== null && filled > 0n ? divDown(cost, filled) : dec(order.average);
  const status: Receipt['status'] = order.status === 'open' ? 'open' : filled === 0n ? 'none' : filled < total ? 'partial' : 'filled';
  return {
    side: order.side,
    status,
    filled: str(filled),
    amount: str(total),
    cost: cost === null ? null : str(cost),
    average: average === null ? null : str(average),
    fee,
    orderId: order.id,
  };
}
