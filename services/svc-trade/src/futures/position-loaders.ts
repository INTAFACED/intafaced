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
          -- no planned ADL pair: its loss leg is fixed at plan time, and a charge meanwhile would leave the
          -- position short of it (adl-pairing.ts). The pair closes or shrinks the row before the next interval.
          AND NOT EXISTS (
            SELECT 1 FROM trade.futures_adl_pairs q
             WHERE q.state = 'planned' AND (q.bankrupt_position_id = p.id OR q.candidate_position_id = p.id))
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

/**
 * All open futures positions (liquidation scan). `closing` rows are excluded — not liquidatable (ADR 2026-08-07).
 *
 * A DATED CONTRACT PAST ITS EXPIRY IS SETTLEMENT'S, NOT LIQUIDATION'S. Once `futures_expiry_at <= now()`
 * the position is settled at the owner fixing (`futures.dated_settlement`), which releases the pot. If the
 * liquidation tick kept rating it, a rung could begin between settlement's read and its posts, settlement
 * would drain the pot, the rung would amend to the insurance leg and the fund would pay for money
 * settlement had already released. So the two never share a position: expired dated positions are not
 * listed here — except one with a rung or ADL pair already live, which is finished first. (A position parked on an expired dated contract
 * waits for an operator — runbook section 2.)
 */
export function sqlLiquidationPositionLoader(sql: Sql): LiquidationPositionLoader {
  return {
    async listOpen() {
      const rows = await sql<OpenPosRow[]>`
        SELECT p.id, p.user_id, p.market_id, p.side, p.size, p.entry_price,
               p.margin_current, p.margin_asset, p.liq_price, m.symbol
        FROM trade.positions p
        JOIN trade.markets m ON m.id = p.market_id
        WHERE p.status = 'open'
          AND (
            NOT (m.futures_contract_style = 'dated' AND m.futures_expiry_at IS NOT NULL AND m.futures_expiry_at <= now())
            -- ...unless a rung is already live: it is finished first (the tick replays a live rung before anything
            -- else), and settlement skips the position until it has. Dropping it here would strand the rung.
            OR EXISTS (SELECT 1 FROM trade.liquidation_rungs r WHERE r.position_id = p.id::text AND r.state IN ('planned', 'posted'))
            -- ...or a planned ADL pair: the tick replays it first, and settlement skips it until it is applied.
            OR EXISTS (SELECT 1 FROM trade.futures_adl_pairs q
                        WHERE q.state = 'planned' AND (q.bankrupt_position_id = p.id OR q.candidate_position_id = p.id))
          )
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
 * Residual window, now closed from the other side: the liquidation loader no longer lists a dated
 * position once its expiry has passed (`sqlLiquidationPositionLoader`), so a NEW rung cannot begin on a
 * position settlement is about to settle. A rung that was already live at expiry is skipped here until it
 * applies. What remains is a rung that began just before expiry and was planned before this read; its
 * closing amendment is raised as `trade.liquidation_insurance_grown` (not silent).
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
          -- no planned ADL pair: its legs may have posted and the row has not caught up (adl-pairing.ts)
          AND NOT EXISTS (
            SELECT 1 FROM trade.futures_adl_pairs q
             WHERE q.state = 'planned' AND (q.bankrupt_position_id = p.id OR q.candidate_position_id = p.id))
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
