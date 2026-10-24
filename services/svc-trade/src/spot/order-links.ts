/**
 * How an OTO entry and its close name each other on the wire (J-cex-spot-08 #10). Read from the stored intent, never
 * from a client order id, so an order cannot claim a link by its name: the entry is the intent's `order_id`, and the
 * close is the `exit_order_id` the intent recorded once it was placed.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';

export type OrderLink =
  /** An entry with an attached close: the close price, and the close order once the entry's fill placed it. */
  | { readonly role: 'entry'; readonly closePrice: string; readonly closeOrderId: string | null }
  /** The close an entry's fill placed. */
  | { readonly role: 'close'; readonly entryOrderId: string };

export async function readOrderLinks(sql: Sql, orderIds: readonly string[]): Promise<Map<string, OrderLink>> {
  const out = new Map<string, OrderLink>();
  if (orderIds.length === 0) return out;
  const rows = await sql<Array<{ order_id: string; exit_order_id: string | null; take_profit: string }>>`
    SELECT order_id, exit_order_id, take_profit::text
      FROM trade.order_bracket_intent
     WHERE kind = 'oto' AND (order_id IN ${sql(orderIds)} OR exit_order_id IN ${sql(orderIds)})
  `;
  const asked = new Set(orderIds);
  for (const row of rows) {
    if (asked.has(row.order_id)) {
      out.set(row.order_id, {
        role: 'entry',
        closePrice: formatAmount(parseAmount(row.take_profit)),
        closeOrderId: row.exit_order_id,
      });
    }
    if (row.exit_order_id !== null && asked.has(row.exit_order_id)) {
      out.set(row.exit_order_id, { role: 'close', entryOrderId: row.order_id });
    }
  }
  return out;
}
