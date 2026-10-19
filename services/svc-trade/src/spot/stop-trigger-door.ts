import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';

export const TRADE_STOP_TRIGGER_INVALID = 'trade.stop_trigger_invalid' as const;

/** Order types a spot caller may place. One list feeds the order mapper and `GET /api/v1/capabilities`. */
export const SPOT_ORDER_TYPES = ['market', 'limit', 'stop_limit'] as const;

export interface StopTriggerStore {
  /** Keep the first trigger for this order id. Returns the stored trigger (the first one wins). */
  remember(orderId: string, userId: string, stopPrice: string): Promise<string>;
  read(orderId: string): Promise<string | null>;
  readMany(orderIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/** The trigger must be a positive amount on the market's tick grid. Trade does not round or invent one. */
export function assertStopTrigger(stopPrice: Amount, tickSize: Amount): void {
  if (stopPrice <= 0n || tickSize <= 0n || stopPrice % tickSize !== 0n) {
    throw new TradeError('stopPrice must be a positive multiple of the tick size', TRADE_STOP_TRIGGER_INVALID);
  }
}

export function sqlStopTrigger(sql: Sql): StopTriggerStore {
  return {
    async remember(orderId, userId, stopPrice) {
      await sql`
        INSERT INTO order_stop_trigger (order_id, user_id, stop_price)
        VALUES (${orderId}, ${userId}, ${stopPrice}::numeric)
        ON CONFLICT (order_id) DO NOTHING
      `;
      const rows = await sql<Array<{ stop_price: string; user_id: string }>>`
        SELECT stop_price::text AS stop_price, user_id FROM order_stop_trigger WHERE order_id = ${orderId}
      `;
      const row = rows[0];
      if (!row || row.user_id !== userId) throw new TradeError('stop trigger could not be recorded', TRADE_STOP_TRIGGER_INVALID);
      return formatAmount(parseAmount(row.stop_price));
    },
    async read(orderId) {
      const rows = await sql<Array<{ stop_price: string }>>`
        SELECT stop_price::text AS stop_price FROM order_stop_trigger WHERE order_id = ${orderId}
      `;
      const raw = rows[0]?.stop_price;
      return raw == null ? null : formatAmount(parseAmount(raw));
    },
    async readMany(orderIds) {
      const out = new Map<string, string>();
      if (orderIds.length === 0) return out;
      const rows = await sql<Array<{ order_id: string; stop_price: string }>>`
        SELECT order_id, stop_price::text AS stop_price FROM order_stop_trigger WHERE order_id IN ${sql(orderIds as string[])}
      `;
      for (const row of rows) out.set(row.order_id, formatAmount(parseAmount(row.stop_price)));
      return out;
    },
  };
}

export function memoryStopTrigger(): StopTriggerStore {
  const byId = new Map<string, { userId: string; stopPrice: string }>();
  return {
    async remember(orderId, userId, stopPrice) {
      const held = byId.get(orderId);
      if (held && held.userId !== userId) throw new TradeError('stop trigger could not be recorded', TRADE_STOP_TRIGGER_INVALID);
      if (!held) byId.set(orderId, { userId, stopPrice });
      return (held ?? { stopPrice }).stopPrice;
    },
    async read(orderId) {
      return byId.get(orderId)?.stopPrice ?? null;
    },
    async readMany(orderIds) {
      const out = new Map<string, string>();
      for (const id of orderIds) {
        const held = byId.get(id);
        if (held) out.set(id, held.stopPrice);
      }
      return out;
    },
  };
}
