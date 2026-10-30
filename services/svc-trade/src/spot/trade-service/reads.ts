/**
 * Reads: orders, amendments, open orders, history, fills, the public tape and candles.
 *
 * Moved out of `trade-service.ts` as it was (owner decision 2026-10-23): `TradeService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import type { Timeframe } from '@intafaced/exchange-contract';
import { requireScope, type Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client';
import { queryCandlesFromFills, assertCandleRangeWithinCap, exportOhlcv, OHLC_RECENT_ROW_CAP } from '../candles.js';
import { publicTapePrint } from '../public-tape.js';
import { orderIdFor } from '../ids.js';
import { toFill, toMarket, toOrder, type FillRow, type MarketRow, type OrderRow } from '../rows.js';
import {
  TradeError,
  type FillRecord,
  type Market,
  type OrderAmendment,
  type OrderRecord,
  type OrderSide,
  type PublicTapePrint,
} from '../types.js';
import type { TradeServiceInternal } from '../trade-service.js';
import {
  publishedAdminOpenOrdersLimit,
  publishedFillsMineLimit,
  publishedOpenOrdersLimit,
  publishedOrderHistoryLimit,
  publishedPublicTapeLimit,
} from './internal.js';

// ── Reads ─────────────────────────────────────────────────────────────────
export async function getOrder(svc: TradeServiceInternal, principal: Principal, orderId: string): Promise<OrderRecord> {
  requireScope(principal, 'trade:read');
  const order = await svc.findOrder(orderId);
  if (!order || order.userId !== principal.userId) {
    throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
  }
  return order;
}

/**
 * Every amend and replace of one order, oldest first. Amends come from the append-only
 * `order_events` rows; a replace is the order this one was replaced by, or the order it replaced.
 * Nothing is derived for an order that was never changed: the list is empty, not invented.
 */
export async function orderAmendments(svc: TradeServiceInternal, principal: Principal, orderId: string): Promise<OrderAmendment[]> {
  const order = await svc.getOrder(principal, orderId);
  const amends = await svc.sql<Array<{ id: string; quantity: string | null; price: string | null; code: string; at: Date }>>`
    SELECT id::text AS id, quantity::text AS quantity, price::text AS price, code, at
    FROM trade.order_events
    WHERE order_id = ${order.id} AND kind = 'amend'
  `;
  const links = await svc.sql<Array<{ id: string; created_at: Date; direction: 'replaced_by' | 'replaces' }>>`
    SELECT id, created_at, 'replaced_by' AS direction
    FROM trade.orders WHERE replacement_of = ${order.id} AND user_id = ${principal.userId}::uuid
    UNION ALL
    SELECT id, created_at, 'replaces' AS direction
    FROM trade.orders WHERE id = ${order.replacementOf ?? null} AND user_id = ${principal.userId}::uuid
  `;
  const rows: Array<OrderAmendment & { sort: number; tie: string }> = [
    ...amends.map((a) => ({
      kind: 'amend' as const,
      at: new Date(a.at).toISOString(),
      quantity: a.quantity,
      price: a.price,
      version: a.code.startsWith('amend:') ? a.code.slice('amend:'.length) : a.code,
      relatedOrderId: null,
      direction: null,
      sort: new Date(a.at).getTime(),
      tie: a.id.padStart(20, '0'),
    })),
    ...links.map((l) => ({
      kind: 'replace' as const,
      at: new Date(l.created_at).toISOString(),
      quantity: null,
      price: null,
      version: null,
      relatedOrderId: l.id,
      direction: l.direction,
      sort: new Date(l.created_at).getTime(),
      tie: l.id,
    })),
  ];
  rows.sort((x, y) => x.sort - y.sort || (x.tie < y.tie ? -1 : x.tie > y.tie ? 1 : 0));
  return rows.map(({ sort: _s, tie: _t, ...rest }) => rest);
}

/**
 * The order this caller already placed under `clientOrderId` on this market,
 * or null when this request would create it. Used to tell an iceberg replay
 * from a new order without a clock.
 */
export async function findClientOrder(
  svc: TradeServiceInternal,
  principal: Principal,
  input: { symbol?: string; marketId?: string; clientOrderId?: string },
): Promise<OrderRecord | null> {
  const clientOrderId = input.clientOrderId;
  if (clientOrderId == null || clientOrderId.length < 1) return null;
  const market = input.marketId ? await svc.marketById(input.marketId) : input.symbol ? await svc.marketBySymbol(input.symbol) : null;
  if (!market) return null;
  const order = await svc.findOrder(orderIdFor(principal.userId, market.id, clientOrderId));
  if (!order || order.userId !== principal.userId) return null;
  return order;
}

/**
 * Self open/pending/recovery rows. Limit is required — same inner door as
 * private REST orders/open and tRPC orders.open. Missing / non-integer / out
 * of 1..500 refuses (never invent 100). Owner/query may pass 100 explicitly.
 */
export async function openOrders(
  svc: TradeServiceInternal,
  principal: Principal,
  marketId: string | undefined,
  limit: number,
): Promise<OrderRecord[]> {
  requireScope(principal, 'trade:read');
  const capped = publishedOpenOrdersLimit(limit);
  const rows = marketId
    ? await svc.sql<OrderRow[]>`
        SELECT * FROM trade.orders
         WHERE user_id = ${principal.userId} AND status IN ('pending', 'open', 'recovery_required', 'hold_unknown') AND market_id = ${marketId}
         ORDER BY created_at DESC
         LIMIT ${capped}
      `
    : await svc.sql<OrderRow[]>`
        SELECT * FROM trade.orders
         WHERE user_id = ${principal.userId} AND status IN ('pending', 'open', 'recovery_required', 'hold_unknown')
         ORDER BY created_at DESC
         LIMIT ${capped}
      `;
  return rows.map(toOrder);
}

/**
 * Operator read of the canonical order rows. Matching remains execution
 * state; this does not reconstruct or maintain a second order book.
 *
 * Limit is required — same inner door as private REST admin/orders/open.
 * Missing / non-integer / out of 1..500 refuses (never invent 100).
 * Owner/query may pass 100 explicitly.
 */
export async function adminOpenOrders(svc: TradeServiceInternal, principal: Principal, limit: number): Promise<OrderRecord[]> {
  requireScope(principal, 'admin:read');
  const capped = publishedAdminOpenOrdersLimit(limit);
  const rows = await svc.sql<OrderRow[]>`
    SELECT * FROM trade.orders
     WHERE status IN ('pending', 'open', 'recovery_required', 'hold_unknown')
     ORDER BY created_at DESC
     LIMIT ${capped}
  `;
  return rows.map(toOrder);
}

/**
 * Terminal orders for the principal (filled / cancelled / rejected / expired).
 * Optional `sinceMs` (unix ms) is applied in SQL on `orders.created_at >= since`
 * (CCXT convention). `created_at` is timestamptz — convert ms via `Date`.
 *
 * Limit is required — same inner door as private REST orders/closed. Missing /
 * non-integer / out of 1..500 refuses (never invent 100). Owner/query may pass
 * 100 explicitly.
 */
export async function orderHistory(
  svc: TradeServiceInternal,
  principal: Principal,
  input: {
    marketId?: string;
    limit: number;
    sinceMs?: number;
    untilMs?: number;
    side?: 'buy' | 'sell';
    status?: 'filled' | 'cancelled' | 'rejected' | 'expired';
    type?: 'market' | 'limit' | 'stop_limit' | 'stop';
    before?: string;
  },
): Promise<OrderRecord[]> {
  requireScope(principal, 'trade:read');
  const limit = publishedOrderHistoryLimit(input.limit);
  // The cursor is the previous page's last order: its (created_at, id) is compared in SQL at full precision, so a
  // page never repeats or skips an order that shares a creation instant with another. Only the caller's own order
  // can be a cursor.
  if (input.before !== undefined) {
    const found = await svc.sql<Array<{ id: string }>>`
      SELECT id FROM trade.orders WHERE id = ${input.before} AND user_id = ${principal.userId}
    `;
    if (!found[0]) throw new TradeError('before must be the id of one of your orders', 'trade.invalid_cursor');
  }
  // timestamptz compare: Date carries ms precision into postgres.js.
  const sinceDate = input.sinceMs !== undefined ? new Date(input.sinceMs) : undefined;
  const untilDate = input.untilMs !== undefined ? new Date(input.untilMs) : undefined;
  const closed = ['filled', 'cancelled', 'rejected', 'expired'];
  const rows = await svc.sql<OrderRow[]>`
    SELECT * FROM trade.orders
     WHERE user_id = ${principal.userId}
       AND status IN ${svc.sql(input.status ? [input.status] : closed)}
       ${input.marketId ? svc.sql`AND market_id = ${input.marketId}` : svc.sql``}
       ${input.side ? svc.sql`AND side = ${input.side}` : svc.sql``}
       ${
         input.type === 'market'
           ? svc.sql`AND type = 'market'`
           : input.type === 'limit'
             ? svc.sql`AND type = 'limit' AND NOT EXISTS (SELECT 1 FROM trade.order_stop_trigger t WHERE t.order_id = trade.orders.id)`
             : input.type === 'stop_limit'
               ? svc.sql`AND type = 'limit' AND EXISTS (SELECT 1 FROM trade.order_stop_trigger t WHERE t.order_id = trade.orders.id AND t.kind = 'stop_limit')`
               : input.type === 'stop'
                 ? svc.sql`AND type = 'limit' AND EXISTS (SELECT 1 FROM trade.order_stop_trigger t WHERE t.order_id = trade.orders.id AND t.kind = 'stop')`
                 : svc.sql``
       }
       ${sinceDate ? svc.sql`AND created_at >= ${sinceDate}` : svc.sql``}
       ${
         // `until` names a whole millisecond and includes all of it: created_at keeps microseconds.
         untilDate ? svc.sql`AND created_at < ${untilDate}::timestamptz + interval '1 millisecond'` : svc.sql``
       }
       ${
         input.before !== undefined
           ? svc.sql`AND (created_at, id) < (SELECT c.created_at, c.id FROM trade.orders c WHERE c.id = ${input.before})`
           : svc.sql``
       }
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit}
  `;
  return rows.map(toOrder);
}

/**
 * User fills, newest first. Optional `marketId` pushes the symbol filter into
 * SQL (`fills.market_id`) so a per-market limit is honest — not a post-filter
 * of a user-wide page that can under-fill the limit.
 * Optional `sinceMs` (unix ms) filters `fills.ts >= since` in SQL (CCXT).
 * `ts` is timestamptz — convert ms via `Date`, never raw int compare.
 *
 * Limit is required — same inner door as private REST account/trades. Missing /
 * non-integer / out of 1..500 refuses (never invent 100). Owner/query may pass
 * 100 explicitly.
 */
export async function myFills(
  svc: TradeServiceInternal,
  principal: Principal,
  limit: number,
  marketId?: string,
  sinceMs?: number,
): Promise<FillRecord[]> {
  requireScope(principal, 'trade:read');
  const capped = publishedFillsMineLimit(limit);
  const sinceDate = sinceMs !== undefined ? new Date(sinceMs) : undefined;
  const rows =
    marketId && sinceDate
      ? await svc.sql<FillRow[]>`
          SELECT * FROM trade.fills
           WHERE user_id = ${principal.userId}
             AND market_id = ${marketId}
             AND ts >= ${sinceDate}
           ORDER BY ts DESC LIMIT ${capped}
        `
      : marketId
        ? await svc.sql<FillRow[]>`
            SELECT * FROM trade.fills
             WHERE user_id = ${principal.userId} AND market_id = ${marketId}
             ORDER BY ts DESC LIMIT ${capped}
          `
        : sinceDate
          ? await svc.sql<FillRow[]>`
              SELECT * FROM trade.fills
               WHERE user_id = ${principal.userId}
                 AND ts >= ${sinceDate}
               ORDER BY ts DESC LIMIT ${capped}
            `
          : await svc.sql<FillRow[]>`
              SELECT * FROM trade.fills
               WHERE user_id = ${principal.userId}
               ORDER BY ts DESC LIMIT ${capped}
            `;
  return rows.map(toFill);
}

/**
 * Fills for one of the caller's orders, oldest first.
 * Limit is required — same 1..500 window as fills.mine / myFills
 * (`publishedFillsMineLimit`). Missing / non-integer / out of range refuses
 * (never invent 100). Owner/query may pass 500 explicitly.
 */
export async function fillsForOrder(
  svc: TradeServiceInternal,
  principal: Principal,
  orderId: string,
  limit: number,
): Promise<FillRecord[]> {
  requireScope(principal, 'trade:read');
  const capped = publishedFillsMineLimit(limit);
  const order = await svc.findOrder(orderId);
  if (!order || order.userId !== principal.userId) {
    throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
  }
  const rows = await svc.sql<FillRow[]>`
    SELECT * FROM trade.fills WHERE order_id = ${orderId} AND user_id = ${principal.userId}
     ORDER BY ts ASC, sequence ASC, id ASC LIMIT ${capped}
  `;
  return rows.map(toFill);
}

/**
 * Every fill of one owned order, not a page: a bot summing an order's fees and proceeds must see all of them. One
 * order's fills are bounded by its quantity over the market lot.
 */
export async function everyFillOfOrder(svc: TradeServiceInternal, principal: Principal, orderId: string): Promise<FillRecord[]> {
  requireScope(principal, 'trade:read');
  const order = await svc.findOrder(orderId);
  if (!order || order.userId !== principal.userId) {
    throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
  }
  const rows = await svc.sql<FillRow[]>`
    SELECT * FROM trade.fills WHERE order_id = ${orderId} AND user_id = ${principal.userId}
     ORDER BY ts ASC, sequence ASC, id ASC
  `;
  return rows.map(toFill);
}

export async function marketById(svc: TradeServiceInternal, marketId: string): Promise<Market | null> {
  const rows = await svc.sql<MarketRow[]>`
    SELECT id, symbol, base_asset, quote_asset, kind, tick_size, lot_size,
           min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
              asset_class, schedule, paper,
              futures_contract_style, futures_expiry_at, futures_settlement_fixing,
              futures_family, futures_settle_asset, contract_size
      FROM trade.markets WHERE id = ${marketId}
  `;
  const row = rows[0];
  return row ? toMarket(row) : null;
}

/**
 * Public trade tape for a market (CCXT `fetchTrades`).
 *
 * One print per match — the taker leg only — so the tape is not doubled.
 * User ids and order ids are intentionally omitted; this is the public print,
 * not `myFills`. Empty market → empty array (honest 200, not an error).
 * Optional `sinceMs` filters `fills.ts >= since` in SQL (timestamptz via Date).
 *
 * Limit is required — same inner door as HTTP trades. Missing / non-integer /
 * out of 1..500 refuses (never invent 100). Owner/HTTP may pass 100 explicitly.
 */
export async function publicTape(svc: TradeServiceInternal, marketId: string, limit: number, sinceMs?: number): Promise<PublicTapePrint[]> {
  const capped = publishedPublicTapeLimit(limit);
  const sinceDate = sinceMs !== undefined ? new Date(sinceMs) : undefined;
  type TapeRow = {
    id: string;
    side: OrderSide;
    price: string;
    qty: string;
    quote_amount: string;
    sequence: number;
    ts: Date;
  };
  // SD-3: exclude prints involving any seeded order (seed volume is not "real activity").
  const rows = sinceDate
    ? await svc.sql<TapeRow[]>`
        SELECT f.id, f.side, f.price, f.qty, f.quote_amount, f.sequence, f.ts
          FROM trade.fills f
          INNER JOIN trade.orders o ON o.id = f.order_id
          INNER JOIN trade.orders c ON c.id = f.counter_order_id
         WHERE f.market_id = ${marketId}
           AND f.liquidity = 'taker'
           AND f.ts >= ${sinceDate}
           AND o.seeded = false
           AND c.seeded = false
         ORDER BY f.sequence DESC
         LIMIT ${capped}
      `
    : await svc.sql<TapeRow[]>`
        SELECT f.id, f.side, f.price, f.qty, f.quote_amount, f.sequence, f.ts
          FROM trade.fills f
          INNER JOIN trade.orders o ON o.id = f.order_id
          INNER JOIN trade.orders c ON c.id = f.counter_order_id
         WHERE f.market_id = ${marketId}
           AND f.liquidity = 'taker'
           AND o.seeded = false
           AND c.seeded = false
         ORDER BY f.sequence DESC
         LIMIT ${capped}
      `;
  return rows.map((row) =>
    publicTapePrint({
      id: row.id,
      side: row.side,
      price: parseAmount(row.price),
      qty: parseAmount(row.qty),
      quoteAmount: parseAmount(row.quote_amount),
      sequence: row.sequence,
      ts: row.ts,
    }),
  );
}

/**
 * Candles for a market (CCXT `fetchOHLCV`), aggregated from real taker fills.
 *
 * SOURCE OF TRUTH: live SQL over `trade.fills` (see `queryCandlesFromFills`).
 * Never invents empty buckets; SD-3 excludes seeded volume. Optional durable
 * materialization is a separate job (`startCandleJobs`, default OFF).
 *
 * Limit is required — same inner door as HTTP OHLCV. Missing / non-integer /
 * out of 1..1000 refuses via `queryCandlesFromFills` (never invent 500).
 * A request is answered in full for the window it asked for, or refused
 * before SQL. Refuse when since→now covers more points than `limit`, or when
 * `limit` is over 720. No shortened series.
 * The export flags the open bucket. Its 720-row slice is only a defensive guard.
 */
export async function candles(svc: TradeServiceInternal, marketId: string, timeframe: Timeframe, limit: number, sinceMs?: number) {
  const endMs = svc.now().getTime();
  if (sinceMs !== undefined) assertCandleRangeWithinCap(timeframe, sinceMs, endMs, limit);
  if (limit > OHLC_RECENT_ROW_CAP) {
    throw new TradeError(`candle limit ${limit} is over the published cap of ${OHLC_RECENT_ROW_CAP}`, 'trade.candles_range_point_cap');
  }
  const rows = await queryCandlesFromFills(svc.sql, { marketId, timeframe, limit, sinceMs });
  return exportOhlcv(rows, timeframe, endMs);
}
