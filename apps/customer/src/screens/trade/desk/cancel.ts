import type { ApiClient } from '../../../shared/api';
import { isTerminalOrder, orderSchema, type Order } from '../../../features/trade/trade-api';

export type CancelResult = { ok: true; order: Order } | { ok: false; reason: 'uncertain' | 'refused' };

/**
 * Cancel one order: a single DELETE, never repeated here.
 *
 * Why this is not `createTradeApi(...).cancel`: the shared client sends `content-type: application/json` on every
 * call, and the trade service refuses a DELETE that has that header and no body
 * (400 `FST_ERR_CTP_EMPTY_JSON_BODY`, seen on the local stack 2026-10-14). The call below sends an empty JSON object,
 * which the service accepts and ignores. The answer is checked the same way the trade client checks it: it must be
 * this very order, and in a final state, or the outcome is treated as unknown.
 */
export async function cancelOrder(client: ApiClient, order: Pick<Order, 'id' | 'symbol'>): Promise<CancelResult> {
  const result = await client.rest(`/orders/${encodeURIComponent(order.id)}`, orderSchema, { method: 'DELETE', body: {} });
  if (!result.ok) return { ok: false, reason: result.reason === 'uncertain' ? 'uncertain' : 'refused' };
  if (result.data.id !== order.id || result.data.symbol !== order.symbol || !isTerminalOrder(result.data))
    return { ok: false, reason: 'uncertain' };
  return { ok: true, order: result.data };
}
