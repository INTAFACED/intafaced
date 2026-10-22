import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { MarketStateSnapshot } from '@intafaced/exchange-contract';
import { TradeError, type Market } from './types.js';
import type { PlaceOrderInput } from './trade-service.js';
import { assertIcebergDisplayRatio, type IcebergDisplayRule } from './iceberg-display-rule.js';

export const TRADE_ICEBERG_DISPLAY_INVALID = 'trade.iceberg_display_invalid' as const;

export interface IcebergDisplayStore {
  remember(orderId: string, userId: string, displayQty: string): Promise<void>;
  read(orderId: string): Promise<string | null>;
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
    /**
     * Owner minimum display ratio (SP-conditional-algo-03). null: refuse every iceberg
     * `trade.iceberg_display_rule_unset`. Required: absent or null refuses (fail closed).
     */
    icebergDisplayRule: IcebergDisplayRule | null;
  },
  input: PlaceOrderInput,
  parsed: { type: string; symbol: string },
  rawDisplay: string | undefined,
): Promise<{ input: PlaceOrderInput; displayQty: string | null }> {
  if (rawDisplay === undefined) return { input, displayQty: null };
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
  assertIcebergDisplayRatio(deps.icebergDisplayRule ?? null, input.qty, display);
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
  };
}

export function memoryIcebergDisplay(): IcebergDisplayStore {
  const byId = new Map<string, string>();
  return {
    async remember(orderId, _userId, displayQty) {
      if (!byId.has(orderId)) byId.set(orderId, displayQty);
    },
    async read(orderId) {
      return byId.get(orderId) ?? null;
    },
  };
}
