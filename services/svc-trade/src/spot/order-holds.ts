import { formatAmount, parseAmount, sub } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { OrderRecord } from './types.js';

export type OrderHold = { readonly asset: string; readonly amount: string };

/**
 * What each live order still holds, for many orders at once (orders lists): the hold placed with the order, less what
 * its fills consumed (quote for a buy, base for a sell) and what a proven amend released. The same sum the cancel path
 * releases (`remainingHold`), read in one query. Only `pending` and `open` orders are present: a closed order's hold is
 * released by the close, and an unresolved one (`recovery_required`, `hold_unknown`) is not stated. An order whose fills
 * exceed its hold is absent too, never shown as a negative or a zero.
 */
export async function readOrderHolds(sql: Sql, orders: readonly OrderRecord[]): Promise<Map<string, OrderHold>> {
  const out = new Map<string, OrderHold>();
  const live = orders.filter((o) => o.status === 'pending' || o.status === 'open');
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
    const left = sub(sub(order.holdAmount, spent), order.amendReleased);
    if (left < 0n) continue;
    out.set(order.id, { asset: order.holdAsset, amount: formatAmount(left) });
  }
  return out;
}
