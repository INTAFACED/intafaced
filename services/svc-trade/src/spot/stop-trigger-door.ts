import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import type { StopKind } from './stop-market.js';

export const TRADE_STOP_TRIGGER_INVALID = 'trade.stop_trigger_invalid' as const;

/** Order types a spot caller may place. One list feeds the order mapper and `GET /api/v1/capabilities`. */
export const SPOT_ORDER_TYPES = ['market', 'limit', 'stop_limit'] as const;

/** When a stop fired, from matching.order.triggered: the reference it watches and the price that reached the stop. */
export interface FiredTrigger {
  readonly at: string;
  readonly by: 'last' | 'mark' | 'index';
  readonly referencePrice: string;
  readonly sequence: number;
}

export interface StopTriggerStore {
  /**
   * Keep the first trigger for this order id. Returns the stored trigger (the first one wins). A replay of the same id
   * as the other stop kind (a stop-limit id sent again as a stop-market, or back) is refused.
   */
  remember(orderId: string, userId: string, stopPrice: string, kind?: StopKind): Promise<string>;
  read(orderId: string): Promise<string | null>;
  readMany(orderIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** The stop-markets among these orders. An order absent here is a stop-limit (or no stop at all). */
  readStopMarkets(orderIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** Record that this order's stop fired. The first record wins; false when the order has no stop here (not a spot stop). */
  recordFired(orderId: string, fired: FiredTrigger): Promise<boolean>;
  /** Fired stops among these orders. An order whose stop has not fired is absent. */
  readFired(orderIds: readonly string[]): Promise<ReadonlyMap<string, FiredTrigger>>;
}

/** The trigger must be a positive amount on the market's tick grid. Trade does not round or invent one. */
export function assertStopTrigger(stopPrice: Amount, tickSize: Amount): void {
  if (stopPrice <= 0n || tickSize <= 0n || stopPrice % tickSize !== 0n) {
    throw new TradeError('stopPrice must be a positive multiple of the tick size', TRADE_STOP_TRIGGER_INVALID);
  }
}

/** Only a plain order uuid can be in the table: a bracket child's id (`<uuid>:sl`) is not, and a uuid column would refuse it. */
const ORDER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positivePrice(raw: string): boolean {
  try {
    return parseAmount(raw) > 0n;
  } catch {
    return false;
  }
}

export function sqlStopTrigger(sql: Sql): StopTriggerStore {
  return {
    async remember(orderId, userId, stopPrice, kind = 'stop_limit') {
      await sql`
        INSERT INTO order_stop_trigger (order_id, user_id, stop_price, kind)
        VALUES (${orderId}, ${userId}, ${stopPrice}::numeric, ${kind})
        ON CONFLICT (order_id) DO NOTHING
      `;
      const rows = await sql<Array<{ stop_price: string; user_id: string; kind: StopKind }>>`
        SELECT stop_price::text AS stop_price, user_id, kind FROM order_stop_trigger WHERE order_id = ${orderId}
      `;
      const row = rows[0];
      if (!row || row.user_id !== userId) throw new TradeError('stop trigger could not be recorded', TRADE_STOP_TRIGGER_INVALID);
      if (row.kind !== kind)
        throw new TradeError(
          `this clientOrderId was already used for a ${row.kind === 'stop' ? 'stop-market' : 'stop-limit'}`,
          TRADE_STOP_TRIGGER_INVALID,
        );
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
    async readStopMarkets(orderIds) {
      if (orderIds.length === 0) return new Set<string>();
      const rows = await sql<Array<{ order_id: string }>>`
        SELECT order_id FROM order_stop_trigger WHERE order_id IN ${sql(orderIds as string[])} AND kind = 'stop'
      `;
      return new Set(rows.map((row) => row.order_id));
    },
    async recordFired(orderId, fired) {
      // An id or price the table would refuse is not recorded: a retry could never land it, and the event would come back forever.
      if (!ORDER_UUID.test(orderId) || !positivePrice(fired.referencePrice)) return false;
      await sql`
        UPDATE order_stop_trigger
        SET triggered_at = ${fired.at}::timestamptz, trigger_reference = ${fired.referencePrice}::numeric,
            trigger_by = ${fired.by}, trigger_sequence = ${fired.sequence}
        WHERE order_id = ${orderId} AND triggered_at IS NULL
      `;
      const rows = await sql<Array<{ order_id: string }>>`SELECT order_id FROM order_stop_trigger WHERE order_id = ${orderId}`;
      return rows.length > 0;
    },
    async readFired(orderIds) {
      const out = new Map<string, FiredTrigger>();
      if (orderIds.length === 0) return out;
      const rows = await sql<
        Array<{ order_id: string; triggered_at: Date; trigger_reference: string; trigger_by: FiredTrigger['by']; trigger_sequence: string }>
      >`
        SELECT order_id, triggered_at, trigger_reference::text AS trigger_reference, trigger_by, trigger_sequence::text AS trigger_sequence
        FROM order_stop_trigger
        WHERE order_id IN ${sql(orderIds as string[])} AND triggered_at IS NOT NULL
      `;
      for (const row of rows) {
        out.set(row.order_id, {
          at: row.triggered_at.toISOString(),
          by: row.trigger_by,
          referencePrice: formatAmount(parseAmount(row.trigger_reference)),
          sequence: Number(row.trigger_sequence),
        });
      }
      return out;
    },
  };
}

export function memoryStopTrigger(): StopTriggerStore {
  const byId = new Map<string, { userId: string; stopPrice: string; kind: StopKind; fired?: FiredTrigger }>();
  return {
    async remember(orderId, userId, stopPrice, kind = 'stop_limit') {
      const held = byId.get(orderId);
      if (held && held.userId !== userId) throw new TradeError('stop trigger could not be recorded', TRADE_STOP_TRIGGER_INVALID);
      if (held && held.kind !== kind)
        throw new TradeError(
          `this clientOrderId was already used for a ${held.kind === 'stop' ? 'stop-market' : 'stop-limit'}`,
          TRADE_STOP_TRIGGER_INVALID,
        );
      if (!held) byId.set(orderId, { userId, stopPrice, kind });
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
    async readStopMarkets(orderIds) {
      return new Set(orderIds.filter((id) => byId.get(id)?.kind === 'stop'));
    },
    async recordFired(orderId, fired) {
      if (!ORDER_UUID.test(orderId) || !positivePrice(fired.referencePrice)) return false;
      const held = byId.get(orderId);
      if (!held) return false;
      if (!held.fired) held.fired = fired;
      return true;
    },
    async readFired(orderIds) {
      const out = new Map<string, FiredTrigger>();
      for (const id of orderIds) {
        const fired = byId.get(id)?.fired;
        if (fired) out.set(id, fired);
      }
      return out;
    },
  };
}
