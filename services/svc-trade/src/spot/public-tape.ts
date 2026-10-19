import type { Amount } from '@intafaced/ledger-client';
import type { OrderSide, PublicTapePrint } from './types.js';

/**
 * One public print. The id is the match sequence, not `trade.fills.id`, so a
 * public tape row cannot be joined to a private fill. Order ids are dropped.
 */
export function publicTapePrint(row: {
  id: string;
  side: OrderSide;
  price: Amount;
  qty: Amount;
  quoteAmount: Amount;
  sequence: number;
  ts: Date;
  orderId?: string;
  counterOrderId?: string;
}): PublicTapePrint {
  void row.id;
  void row.orderId;
  void row.counterOrderId;
  return {
    id: String(row.sequence),
    side: row.side,
    price: row.price,
    qty: row.qty,
    quoteAmount: row.quoteAmount,
    sequence: row.sequence,
    ts: row.ts,
  };
}
