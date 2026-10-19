import type { ApiClient } from '../../../shared/api';
import { isTerminalOrder, orderSchema, placeBody, type Draft, type Order } from '../../../features/trade/trade-api';
import type { ScaleOutcome } from './ticket/scale-flow';

export type ResendResult =
  | { ok: true; order: Order }
  /** `unsure`: the answer was lost again or did not match; keep the marker. `refused`: the service said no, nothing was placed. */
  | { ok: false; reason: 'unsure' | 'refused' | 'unauthorized' | 'forbidden'; code?: string };

export function resendOutcome(result: ResendResult): ScaleOutcome {
  if (result.ok) return 'accounted';
  if (result.reason === 'unsure') return 'lost';
  if (result.reason === 'unauthorized') return 'unauthorized';
  if (result.reason === 'forbidden') return 'forbidden';
  return 'refused';
}

/** The code the trade service uses when the same order number comes back with a different order. */
export const CONFLICT_CODE = 'trade.client_order_id_conflict';

/**
 * Send the SAME order again, on the person's click, with the SAME `clientOrderId`.
 *
 * The trade service keeps one order per (user, market, clientOrderId): if the first send arrived, this returns that
 * order; if it never did, this places it. So it cannot create a second order. It is one POST, no retry. A different
 * body under the same id would be refused with `trade.client_order_id_conflict`, which never happens here because
 * the draft is stored exactly as it was first sent. No fresh preview is asked: the order is the one already reviewed.
 */
export async function resendOrder(client: ApiClient, draft: Draft): Promise<ResendResult> {
  const result = await client.rest('/orders', orderSchema, { method: 'POST', body: placeBody(draft) });
  if (!result.ok) {
    if (result.reason === 'uncertain') return { ok: false, reason: 'unsure' };
    if (result.reason === 'unauthorized') return { ok: false, reason: 'unauthorized' };
    if (result.reason === 'forbidden') return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'refused', ...(result.code ? { code: result.code } : {}) };
  }
  const order = result.data;
  if (order.symbol !== draft.symbol || order.clientOrderId !== draft.clientOrderId) return { ok: false, reason: 'unsure' };
  if (order.recoveryRequired && !isTerminalOrder(order)) return { ok: false, reason: 'unsure' };
  return { ok: true, order };
}
