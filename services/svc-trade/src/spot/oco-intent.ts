/**
 * The legs of an OCO parent, stored under its deterministic order id before the hold is placed, so a resubmit
 * from a booked hold_unknown row sends the same legs instead of a plain limit.
 * Its own module: trade-service.ts reads it, and oco-place.ts imports trade-service.ts.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { orderIdFor } from './ids.js';
import { TradeError } from './types.js';

export async function rememberOcoIntent(
  sql: Sql,
  userId: string,
  marketId: string,
  input: { readonly clientOrderId?: unknown },
  takeProfit: Amount,
  stopLoss: Amount,
  stopLossLimit: Amount | null,
): Promise<void> {
  const clientOrderId = typeof input.clientOrderId === 'string' ? input.clientOrderId : '';
  if (clientOrderId.length === 0) {
    throw new TradeError('clientOrderId is required (1–64 chars) so a retry cannot open a second hold', 'trade.client_order_id_required');
  }
  const orderId = orderIdFor(userId, marketId, clientOrderId);
  const limit = stopLossLimit === null ? null : formatAmount(stopLossLimit);
  await sql`
    INSERT INTO trade.order_oco_intent (order_id, user_id, take_profit, stop_loss, stop_loss_limit)
    VALUES (${orderId}, ${userId}, ${formatAmount(takeProfit)}::numeric, ${formatAmount(stopLoss)}::numeric, ${limit}::numeric)
    ON CONFLICT (order_id) DO NOTHING
  `;
  const rows = await sql<Array<{ take_profit: string; stop_loss: string; stop_loss_limit: string | null }>>`
    SELECT take_profit::text, stop_loss::text, stop_loss_limit::text FROM trade.order_oco_intent WHERE order_id = ${orderId}
  `;
  const stored = rows[0];
  const same =
    stored !== undefined &&
    parseAmount(stored.take_profit) === takeProfit &&
    parseAmount(stored.stop_loss) === stopLoss &&
    (stored.stop_loss_limit === null
      ? stopLossLimit === null
      : stopLossLimit !== null && parseAmount(stored.stop_loss_limit) === stopLossLimit);
  if (!same) {
    throw new TradeError('clientOrderId was already used for an OCO with different legs', 'trade.client_order_id_conflict');
  }
}

/** The stored OCO legs for a parent order id, shaped as placement input, or null when it is not an OCO. */
export async function readOcoIntent(
  sql: Sql,
  orderId: string,
): Promise<{ oco: true; takeProfit: { stopPrice: string }; stopLoss: { stopPrice: string; price?: string } } | null> {
  const rows = await sql<Array<{ take_profit: string; stop_loss: string; stop_loss_limit: string | null }>>`
    SELECT take_profit::text, stop_loss::text, stop_loss_limit::text FROM trade.order_oco_intent WHERE order_id = ${orderId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    oco: true,
    takeProfit: { stopPrice: formatAmount(parseAmount(row.take_profit)) },
    stopLoss: {
      stopPrice: formatAmount(parseAmount(row.stop_loss)),
      ...(row.stop_loss_limit === null ? {} : { price: formatAmount(parseAmount(row.stop_loss_limit)) }),
    },
  };
}

/** Remove the intent for this parent id when no order row exists under it. A real order keeps its intent. */
export async function forgetOcoIntentWithoutOrder(
  sql: Sql,
  userId: string,
  marketId: string,
  input: { readonly clientOrderId?: unknown },
): Promise<void> {
  const clientOrderId = typeof input.clientOrderId === 'string' ? input.clientOrderId : '';
  if (clientOrderId.length === 0) return;
  const orderId = orderIdFor(userId, marketId, clientOrderId);
  await sql`
    DELETE FROM trade.order_oco_intent
     WHERE order_id = ${orderId} AND NOT EXISTS (SELECT 1 FROM trade.orders WHERE id = ${orderId})
  `;
}
