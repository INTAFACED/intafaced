/**
 * Cancel all open orders, in one market or in every market (ticket v2, Orders tab).
 *
 * One `DELETE /api/v1/orders[?symbol=]`, no retry. The service cancels the account's open orders one after another, so
 * if it stops partway some are cancelled and some are not: any answer other than a clean list of ended orders is
 * reported as "not sure", and the screen reads Open orders again for the truth. Cancels are never blocked by the
 * operator's kill switch (they let people out), so this works during an incident too.
 */
import { z } from 'zod';
import type { ApiClient } from '../../../../shared/api';
import { isTerminalOrder, orderSchema } from '../../../../features/trade/trade-api';

export type CancelAllResult =
  /** Every order the service returned has ended. `cancelled` of them were cancelled; the rest had just filled. */
  | { kind: 'done'; cancelled: number }
  /** The answer was lost, unreadable or incomplete: some orders may still be open. */
  | { kind: 'unsure' }
  /** The service said no. Orders it had already cancelled before saying so stay cancelled. */
  | { kind: 'failed'; code: string | null };

export async function cancelAllOrders(client: ApiClient, symbol?: string): Promise<CancelAllResult> {
  const result = await client.rest('/orders', z.array(orderSchema), { method: 'DELETE', query: { symbol } });
  if (!result.ok) return result.reason === 'uncertain' ? { kind: 'unsure' } : { kind: 'failed', code: result.code ?? null };
  const orders = result.data;
  if (!orders.every((order) => isTerminalOrder(order) && (symbol === undefined || order.symbol === symbol))) return { kind: 'unsure' };
  return { kind: 'done', cancelled: orders.filter((order) => order.status === 'canceled').length };
}

/** How many open orders there are per market, in the order the markets first appear. */
export function countBySymbol(rows: readonly { symbol: string }[]): Array<{ symbol: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.symbol, (counts.get(row.symbol) ?? 0) + 1);
  return [...counts].map(([symbol, count]) => ({ symbol, count }));
}
