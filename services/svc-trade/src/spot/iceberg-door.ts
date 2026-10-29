import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { MarketStateSnapshot } from '@intafaced/exchange-contract';
import { TradeError, type Market } from './types.js';
import type { PlaceOrderInput } from './trade-service.js';

export const TRADE_ICEBERG_DISPLAY_INVALID = 'trade.iceberg_display_invalid' as const;
/** An account rests at most one live iceberg per market; a second is refused until the first is done. */
export const TRADE_ICEBERG_SYMBOL_CAP = 'trade.iceberg_symbol_cap' as const;

/** Order statuses that still rest on the book or may: the slot stays taken while the order is in one of them. */
const LIVE_STATUSES = ['pending', 'open', 'recovery_required', 'hold_unknown'] as const;

export interface IcebergDisplayStore {
  remember(orderId: string, userId: string, displayQty: string): Promise<void>;
  read(orderId: string): Promise<string | null>;
  /**
   * Runs `place` (the placement and its `remember`) only while this account has no other live iceberg on the market,
   * and holds out every other new iceberg of the account on that market until `place` settles. Otherwise refuses
   * `trade.iceberg_symbol_cap` and places nothing.
   */
  oneLivePerMarket<T>(userId: string, marketId: string, symbol: string, place: () => Promise<T>): Promise<T>;
}

function symbolCap(symbol: string): TradeError {
  return new TradeError(
    `${symbol}: this account already has a live iceberg on this market; cancel it or let it fill first`,
    TRADE_ICEBERG_SYMBOL_CAP,
  );
}

/**
 * Matching refuses a display that is not strictly smaller than the order
 * (`trade.iceberg_display_not_smaller`). This door uses one code for that and
 * for a non-positive peak, a peak above the order, a peak off the lot, a
 * non-limit order, or a market whose lifecycle does not allow PLACE.
 */
export function assertIcebergDisplay(qty: Amount, displayQty: Amount, lotSize: Amount): void {
  if (displayQty <= 0n || displayQty >= qty || lotSize <= 0n || displayQty % lotSize !== 0n) {
    throw new TradeError(
      'iceberg displayQty must be greater than zero, smaller than the order quantity, and a multiple of the lot',
      TRADE_ICEBERG_DISPLAY_INVALID,
    );
  }
}

export function readRawDisplayQty(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = (body as { displayQty?: unknown }).displayQty;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new TradeError('iceberg displayQty must be a decimal string', TRADE_ICEBERG_DISPLAY_INVALID);
  }
  return raw;
}

export async function attachIcebergDisplay(
  deps: {
    marketBySymbol(symbol: string): Promise<Market | null>;
    lifecycleForMarket?(market: Market): MarketStateSnapshot | null | Promise<MarketStateSnapshot | null>;
  },
  input: PlaceOrderInput,
  parsed: { type: string; symbol: string },
  rawDisplay: string | undefined,
): Promise<{ input: PlaceOrderInput; displayQty: string | null; marketId: string | null }> {
  if (rawDisplay === undefined) return { input, displayQty: null, marketId: null };
  if (parsed.type !== 'limit') {
    throw new TradeError('iceberg displayQty is valid only on a limit order', TRADE_ICEBERG_DISPLAY_INVALID);
  }
  let display: Amount;
  try {
    if (rawDisplay.trim() === '') throw new Error('blank');
    display = parseAmount(rawDisplay);
  } catch {
    throw new TradeError('iceberg displayQty must be a decimal string', TRADE_ICEBERG_DISPLAY_INVALID);
  }
  const market = await deps.marketBySymbol(parsed.symbol);
  if (!market) throw new TradeError(`market ${parsed.symbol} not found`, 'trade.market_not_found');
  assertIcebergDisplay(input.qty, display, market.lotSize);
  if (!deps.lifecycleForMarket) {
    throw new TradeError('market lifecycle authority is not configured', 'trade.lifecycle_authority_unavailable');
  }
  const snapshot = await deps.lifecycleForMarket(market);
  if (!snapshot || !snapshot.allowedActions.includes('PLACE')) {
    throw new TradeError('iceberg displayQty is valid only when the market lifecycle allows PLACE', TRADE_ICEBERG_DISPLAY_INVALID);
  }
  return {
    input: Object.assign({}, input, { iceberg: true, displayQty: display }),
    displayQty: formatAmount(display),
    marketId: market.id,
  };
}

export function sqlIcebergDisplay(sql: Sql): IcebergDisplayStore {
  return {
    async remember(orderId, userId, displayQty) {
      await sql`
        INSERT INTO order_iceberg_display (order_id, user_id, display_qty)
        VALUES (${orderId}, ${userId}, ${displayQty}::numeric)
        ON CONFLICT (order_id) DO NOTHING
      `;
    },
    async read(orderId) {
      const rows = await sql<Array<{ display_qty: string }>>`
        SELECT display_qty::text AS display_qty FROM order_iceberg_display WHERE order_id = ${orderId}
      `;
      const raw = rows[0]?.display_qty;
      return raw == null ? null : formatAmount(parseAmount(raw));
    },
    async oneLivePerMarket(userId, marketId, symbol, place) {
      // A session lock on one pinned connection: two new icebergs of one account on one market take turns, and a crash
      // drops the connection and with it the lock. The check reads the orders the peaks belong to, so a cancelled,
      // filled or refused iceberg frees the slot without any release step.
      const connection = await sql.reserve();
      const key = `iceberg-slot:${userId}:${marketId}`;
      let locked = false;
      try {
        await connection`SELECT pg_advisory_lock(hashtext(${key}))`;
        locked = true;
        const live = await connection<Array<{ n: number }>>`
          SELECT count(*)::int AS n
          FROM order_iceberg_display d
          JOIN orders o ON o.id = d.order_id
          WHERE d.user_id = ${userId} AND o.user_id = ${userId} AND o.market_id = ${marketId}
            AND o.status::text IN ${connection([...LIVE_STATUSES])}
        `;
        if ((live[0]?.n ?? 0) > 0) throw symbolCap(symbol);
        return await place();
      } finally {
        try {
          if (locked) await connection`SELECT pg_advisory_unlock(hashtext(${key}))`;
        } finally {
          connection.release();
        }
      }
    },
  };
}

/** `liveOn` lists the account's live order ids on a market; without it no order counts as live. */
export function memoryIcebergDisplay(opts: { liveOn?: (userId: string, marketId: string) => readonly string[] } = {}): IcebergDisplayStore {
  const byId = new Map<string, string>();
  const turns = new Map<string, Promise<unknown>>();
  return {
    async oneLivePerMarket(userId, marketId, symbol, place) {
      const key = `${userId}:${marketId}`;
      const run = (turns.get(key) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          if ((opts.liveOn?.(userId, marketId) ?? []).some((id) => byId.has(id))) throw symbolCap(symbol);
          return place();
        });
      turns.set(key, run);
      return run;
    },
    async remember(orderId, _userId, displayQty) {
      if (!byId.has(orderId)) byId.set(orderId, displayQty);
    },
    async read(orderId) {
      return byId.get(orderId) ?? null;
    },
  };
}
