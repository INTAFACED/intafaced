import { formatAmount, parseAmount, sub, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { OrderRecord } from './types.js';

export type OrderHold = { readonly asset: string; readonly amount: string };

/**
 * What is left of one order's hold: the hold placed with it, less what its fills consumed (quote for a buy, base for a
 * sell) and what a proven amend released. The one formula the cancel path releases (`remainingHold`) and the orders
 * read shows; negative means the fills overspent the hold, which each caller refuses in its own way.
 */
export function holdLeft(order: Pick<OrderRecord, 'holdAmount' | 'amendReleased'>, consumed: Amount): Amount {
  return sub(sub(order.holdAmount, consumed), order.amendReleased);
}

/**
 * What each open order still holds, for many orders at once (orders lists), read in one query. Only `open` orders are
 * present: a `pending` order may not have its hold posted yet, a closed order's hold is released by the close, and an
 * unresolved one (`recovery_required`, `hold_unknown`) is not stated. An order whose fills exceed its hold is absent
 * too, never shown as a negative or a zero.
 */
export async function readOrderHolds(sql: Sql, orders: readonly OrderRecord[]): Promise<Map<string, OrderHold>> {
  const out = new Map<string, OrderHold>();
  const live = orders.filter((o) => o.status === 'open');
  if (live.length === 0) return out;
  const rows = await sql<Array<{ order_id: string; base: string; quote: string }>>`
    SELECT order_id, COALESCE(SUM(qty), 0)::text AS base, COALESCE(SUM(quote_amount), 0)::text AS quote
      FROM trade.fills WHERE order_id IN ${sql(live.map((o) => o.id))}
     GROUP BY order_id
  `;
  const consumed = new Map(rows.map((r) => [r.order_id, r]));
  for (const order of live) {
    const fills = consumed.get(order.id);
    const spent = fills ? parseAmount(order.side === 'buy' ? fills.quote : fills.base) : 0n;
    const left = holdLeft(order, spent);
    if (left < 0n) continue;
    out.set(order.id, { asset: order.holdAsset, amount: formatAmount(left) });
  }
  return out;
}
