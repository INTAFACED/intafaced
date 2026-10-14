/**
 * SQL position loaders for funding/liq ticks (trade.futures residual).
 *
 * Read-only open positions. Never invents rows or marks.
 */
import type { Sql } from 'postgres';
import { parseAmount } from '@intafaced/ledger-client';
import type { FundingOpenPosition } from './funding-settlement.js';
import type { FundingPositionLoader } from './funding-tick.js';
import type { LiquidationPositionLoader, LiquidationPositionRow } from './liquidation-tick.js';
import type {
  DatedSettlementMarket,
  DatedSettlementMarkets,
  DatedSettlementPositions,
  DatedFuturesSettlementPosition,
} from './dated-futures-settlement.js';

interface OpenPosRow {
  id: string;
  user_id: string;
  market_id: string;
  side: 'long' | 'short';
  size: string;
  entry_price: string;
  /** Residual margin after funding — not the open-time figure. */
  margin_current: string;
  margin_asset: string;
  liq_price: string | null;
  symbol: string;
}

function mapFunding(row: OpenPosRow): FundingOpenPosition {
  return {
    positionId: row.id,
    userId: row.user_id,
    side: row.side,
    size: parseAmount(row.size),
    entryPrice: parseAmount(row.entry_price),
    marginAsset: row.margin_asset,
  };
}

function mapLiq(row: OpenPosRow): LiquidationPositionRow {
  return {
    positionId: row.id,
    userId: row.user_id,
    side: row.side,
    size: parseAmount(row.size),
    entryPrice: parseAmount(row.entry_price),
    margin: parseAmount(row.margin_current),
    marginAsset: row.margin_asset,
    liqPrice: row.liq_price != null ? parseAmount(row.liq_price) : null,
    marketId: row.market_id,
    symbol: row.symbol,
  };
}

/** Open positions for one market (funding settlement). `closing` rows are excluded — they accrue no funding (ADR 2026-08-07). */
export function sqlFundingPositionLoader(sql: Sql): FundingPositionLoader {
  return {
    async listOpenForMarket(marketId) {
      const rows = await sql<OpenPosRow[]>`
        SELECT p.id, p.user_id, p.market_id, p.side, p.size, p.entry_price,
               p.margin_current, p.margin_asset, p.liq_price, m.symbol
        FROM trade.positions p
        JOIN trade.markets m ON m.id = p.market_id
        WHERE p.status = 'open' AND p.market_id = ${marketId}
        -- p.id is the tiebreak, not decoration: opened_at is not unique, so two
        -- positions opened in the same tick had no stable order between two
        -- queries. Funding legs are built by iterating this list, and under the
        -- old loop-counter ledger key a mere row-order flip between a crashed
        -- tick and its replay re-posted the ENTIRE plan. The key no longer
        -- depends on order, so this is belt-and-braces — but a money path that
        -- reads rows in a nondeterministic order has no business doing so.
        ORDER BY p.opened_at ASC, p.id ASC
      `;
      return rows.map(mapFunding);
    },
  };
}

/** All open futures positions (liquidation scan). `closing` rows are excluded — not liquidatable (ADR 2026-08-07). */
export function sqlLiquidationPositionLoader(sql: Sql): LiquidationPositionLoader {
  return {
    async listOpen() {
      const rows = await sql<OpenPosRow[]>`
        SELECT p.id, p.user_id, p.market_id, p.side, p.size, p.entry_price,
               p.margin_current, p.margin_asset, p.liq_price, m.symbol
        FROM trade.positions p
        JOIN trade.markets m ON m.id = p.market_id
        WHERE p.status = 'open'
        ORDER BY p.opened_at ASC
      `;
      return rows.map(mapLiq);
    },
  };
}

function mapDatedClose(row: OpenPosRow): DatedFuturesSettlementPosition {
  return {
    positionId: row.id,
    userId: row.user_id,
    side: row.side,
    size: parseAmount(row.size),
    entryPrice: parseAmount(row.entry_price),
    margin: parseAmount(row.margin_current),
    marginAsset: row.margin_asset,
  };
}

/** Expired dated markets (settlement scan). Never invents a last-trade price. */
export function sqlDatedSettlementMarketLoader(sql: Sql): DatedSettlementMarkets {
  return {
    async listExpiredDated(now) {
      const rows = await sql<
        {
          id: string;
          futures_contract_style: 'dated' | 'perpetual' | null;
          futures_expiry_at: Date | null;
        }[]
      >`
        SELECT id, futures_contract_style, futures_expiry_at
        FROM trade.markets
        WHERE kind = 'futures'
          AND futures_contract_style = 'dated'
          AND futures_expiry_at IS NOT NULL
          AND futures_expiry_at <= ${now}
        ORDER BY futures_expiry_at ASC, id ASC
      `;
      return rows.map((row): DatedSettlementMarket => ({
        marketId: row.id,
        style: row.futures_contract_style === 'dated' ? 'dated' : row.futures_contract_style,
        expiryAt: row.futures_expiry_at,
      }));
    },
  };
}

/**
 * Open positions on one dated market (settlement scan). `closing` excluded.
 *
 * DATED POSITIONS RUN THROUGH LIQUIDATION RUNGS TOO: `sqlLiquidationPositionLoader` lists every
 * open position whatever its market's contract style, so a dated position can have a live rung (or be
 * parked) at the moment its expiry passes. Settlement posts the position's margin release and PnL to
 * the ledger, so the gate has to be HERE, before anything posts. A position with a live rung is left
 * for a later scan (the rung applies within a tick, and settlement is idempotent on
 * `dated-settle:<id>`); a PARKED position is left until an operator resolves it (runbook section 2),
 * because its row is not reconciled with a loss that is already booked.
 *
 * Residual window: a rung that begins between this read and the settlement's own posts. That rung
 * then applies against a row `sqlDatedSettlementCloser` has closed and is abandoned
 * (`trade.liquidation_row_changed_after_post`), which parks and alerts loudly — the same ending as
 * before this gate, and rare (settlement is a few statements; a rung needs an unhealthy position at
 * expiry).
 */
export function sqlDatedSettlementPositionLoader(sql: Sql): DatedSettlementPositions {
  return {
    async listOpenForMarket(marketId) {
      const rows = await sql<OpenPosRow[]>`
        SELECT p.id, p.user_id, p.market_id, p.side, p.size, p.entry_price,
               p.margin_current, p.margin_asset, p.liq_price, m.symbol
        FROM trade.positions p
        JOIN trade.markets m ON m.id = p.market_id
        WHERE p.status = 'open' AND p.market_id = ${marketId}
          -- no live (planned/posted) rung: its loss is booked or about to be and the row has not caught up
          AND NOT EXISTS (
            SELECT 1 FROM trade.liquidation_rungs r
             WHERE r.position_id = p.id::text AND r.state IN ('planned', 'posted'))
          -- not parked: latest rung abandoned, or an old-style claim on a still-open position
          AND COALESCE((
            SELECT r.state FROM trade.liquidation_rungs r
             WHERE r.position_id = p.id::text ORDER BY r.created_at DESC, r.rung_id DESC LIMIT 1), '') <> 'abandoned'
          AND NOT EXISTS (
            SELECT 1 FROM trade.liquidation_attempts a WHERE a.liquidation_id = 'liq:' || p.id::text)
        ORDER BY p.opened_at ASC, p.id ASC
      `;
      return rows.map(mapDatedClose);
    },
  };
}

/** In-memory loaders for unit tests. */
export function memoryFundingPositionLoader(rows: readonly FundingOpenPosition[]): FundingPositionLoader {
  return {
    async listOpenForMarket() {
      return rows;
    },
  };
}

export function memoryLiquidationPositionLoader(rows: readonly LiquidationPositionRow[]): LiquidationPositionLoader {
  return {
    async listOpen() {
      return rows;
    },
  };
}
