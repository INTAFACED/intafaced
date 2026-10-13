/**
 * Durable stores for funding/liq ticks (trade.futures residual).
 *
 * Period / attempt IDENTITY only — never invents rates, marks, or balances.
 */
import type { Sql } from 'postgres';
import {
  positionsFromFundingSnapshots,
  snapshotFundingMembers,
  type FundingMarginApplier,
  type FundingMemberSnapshot,
  type FundingPeriodStore,
} from './funding-tick.js';
import type { LiquidationAttemptStore, PositionCloser, PositionReducer } from './liquidation-tick.js';
import type { EventBus } from '@intafaced/events';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';

/**
 * Move margin_current / funding_paid with the ledger after funding posts.
 *
 * ONCE PER (POSITION, PERIOD), and that is the whole design.
 *
 * `runFundingTick` posts to the ledger, calls this, and only then marks the
 * period settled. A restart in the gap leaves the period unsettled, so the next
 * tick re-runs it: the ledger dedupes on its own key and moves nothing twice,
 * and before 0014 this decremented `margin_current` a second time anyway. The
 * trader's residual margin then read lower than the ledger said they had paid
 * for — liquidating early, releasing short, and clamped at zero by GREATEST so
 * nothing raised.
 *
 * The claim and the update are ONE statement. Two statements would only move
 * the crash window rather than close it.
 *
 * paid > 0: position paid (margin_current down). paid < 0: received to available only.
 */
export function sqlFundingMarginApplier(sql: Sql): FundingMarginApplier {
  return {
    async applyFundingNets(nets, periodId) {
      for (const { positionId, paid } of nets) {
        if (paid === 0n) continue;
        const paidStr = formatAmount(paid < 0n ? -paid : paid);
        const signedStr = formatAmount(paid);
        if (paid > 0n) {
          // Payer: reduce residual margin (floor at 0), accumulate funding_paid.
          await sql`
            WITH claim AS (
              INSERT INTO trade.position_funding_applied (position_id, period_id, paid)
              VALUES (${positionId}, ${periodId}, ${signedStr}::numeric)
              ON CONFLICT (position_id, period_id) DO NOTHING
              RETURNING position_id
            )
            UPDATE trade.positions
               SET margin_current = GREATEST(margin_current - ${paidStr}::numeric, 0),
                   funding_paid = funding_paid + ${paidStr}::numeric,
                   updated_at = now()
             WHERE id = ${positionId}
               AND status = 'open'
               AND EXISTS (SELECT 1 FROM claim)
          `;
        } else {
          // Payee: funding lands in available, not re-margin; track net only.
          await sql`
            WITH claim AS (
              INSERT INTO trade.position_funding_applied (position_id, period_id, paid)
              VALUES (${positionId}, ${periodId}, ${signedStr}::numeric)
              ON CONFLICT (position_id, period_id) DO NOTHING
              RETURNING position_id
            )
            UPDATE trade.positions
               SET funding_paid = funding_paid - ${paidStr}::numeric,
                   updated_at = now()
             WHERE id = ${positionId}
               AND status = 'open'
               AND EXISTS (SELECT 1 FROM claim)
          `;
        }
      }
    },
  };
}

export function sqlFundingPeriodStore(sql: Sql): FundingPeriodStore {
  return {
    async isSettled(periodId) {
      const rows = await sql<{ period_id: string }[]>`
        SELECT period_id FROM trade.funding_periods WHERE period_id = ${periodId} LIMIT 1
      `;
      return rows.length > 0;
    },
    async markSettled(periodId, meta) {
      // market_id embedded in periodId when using periodIdFor(market, iso)
      const marketId = periodId.includes(':') ? periodId.slice(0, periodId.indexOf(':')) : periodId;
      await sql`
        INSERT INTO trade.funding_periods (period_id, market_id, leg_count)
        VALUES (${periodId}, ${marketId}, ${meta.legCount})
        ON CONFLICT (period_id) DO NOTHING
      `;
    },
    async freezeMembership(periodId, candidates) {
      // market_id from periodId prefix — same rule as markSettled (never invent a market).
      const marketId = periodId.includes(':') ? periodId.slice(0, periodId.indexOf(':')) : periodId;
      const ids = candidates.map((c) => c.positionId);
      const snaps = snapshotFundingMembers(candidates);
      // First writer freezes ids + size/notional atomically. Replays and
      // concurrent ticks see the same plan inputs; new openers never join and
      // live size changes cannot re-size the charge.
      await sql`
        INSERT INTO trade.funding_period_membership (period_id, market_id, member_position_ids, member_snapshots)
        VALUES (${periodId}, ${marketId}, ${ids}::text[], ${sql.json(snaps as never)})
        ON CONFLICT (period_id) DO NOTHING
      `;
      const rows = await sql<{ member_position_ids: string[]; member_snapshots: FundingMemberSnapshot[] | null }[]>`
        SELECT member_position_ids, member_snapshots
          FROM trade.funding_period_membership
         WHERE period_id = ${periodId}
         LIMIT 1
      `;
      const row = rows[0];
      if (!row) {
        // Insert raced with a delete or table missing — refuse rather than
        // fall back to open-now (that is the defect this table closes).
        throw new Error(`funding membership freeze for ${periodId} produced no row — refusing open-now fallback`);
      }
      if (row.member_snapshots != null && Array.isArray(row.member_snapshots) && row.member_snapshots.length > 0) {
        return positionsFromFundingSnapshots(row.member_snapshots);
      }
      // Pre-0020 row (ids only) or empty snapshots: refuse open-now size re-read.
      // Periods frozen before this migration must not re-plan live sizes.
      if (row.member_position_ids?.length) {
        throw new Error(
          `funding membership freeze for ${periodId} has ids but no size snapshots — refuse open-now size fallback (run migration 0020)`,
        );
      }
      return [];
    },
    async recordSkip(periodId, meta) {
      await sql`
        INSERT INTO trade.funding_period_skips (period_id, market_id, reason)
        VALUES (${periodId}, ${meta.marketId}, ${meta.reason})
      `;
    },
    async lastSkip(periodId) {
      const rows = await sql<{ reason: 'no_rate' | 'no_positions'; market_id: string }[]>`
        SELECT reason, market_id FROM trade.funding_period_skips
         WHERE period_id = ${periodId}
         ORDER BY recorded_at DESC
         LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return { reason: row.reason, marketId: row.market_id };
    },
    async settledLegCount(periodId) {
      const rows = await sql<{ leg_count: number }[]>`
        SELECT leg_count FROM trade.funding_periods WHERE period_id = ${periodId} LIMIT 1
      `;
      return rows[0] ? rows[0].leg_count : null;
    },
  };
}

export function sqlLiquidationAttemptStore(sql: Sql): LiquidationAttemptStore {
  return {
    async isDone(liquidationId) {
      const rows = await sql<{ liquidation_id: string }[]>`
        SELECT liquidation_id FROM trade.liquidation_attempts
        WHERE liquidation_id = ${liquidationId} LIMIT 1
      `;
      return rows.length > 0;
    },
    /**
     * INSERT … ON CONFLICT DO NOTHING RETURNING — true only for the worker that
     * created the row. That is the claim that must precede any loss post.
     */
    async tryClaim(liquidationId) {
      const rows = await sql<{ liquidation_id: string }[]>`
        INSERT INTO trade.liquidation_attempts (liquidation_id)
        VALUES (${liquidationId})
        ON CONFLICT (liquidation_id) DO NOTHING
        RETURNING liquidation_id
      `;
      return rows.length > 0;
    },
    async markDone(liquidationId) {
      await sql`
        INSERT INTO trade.liquidation_attempts (liquidation_id)
        VALUES (${liquidationId})
        ON CONFLICT (liquidation_id) DO NOTHING
      `;
    },
  };
}

/**
 * Shrink a position after a PARTIAL liquidation rung.
 *
 * ONE STATEMENT, AND THE GUARDS ARE IN THE `WHERE`.
 *
 * `size > sizeClosed` is the important one. A partial rung must never take a
 * position to zero through this path: `positions_size_positive_ck` would reject
 * it, and the exception would arrive AFTER the tranche's realised loss had
 * already posted to the ledger. Filtering in the predicate turns that into a
 * no-op the tick can see instead of a half-applied liquidation. A rung that
 * genuinely exhausts the position is `closesPosition` and goes through
 * `sqlPositionCloser` — this function is not the path for it.
 *
 * `status = 'open'` covers the concurrent voluntary close: a trader who closes
 * the whole position between the plan and this write leaves nothing to shrink,
 * and the row must not be resurrected to a smaller size.
 *
 * NO EVENT IS PUBLISHED HERE. `positionUpdated` carries `status`, and there is no
 * honest status for "still open, smaller than it was" on that schema today.
 * Publishing `open` with the new size would be truthful about the size and silent
 * about the fact that a liquidation just took part of it, which is the kind of
 * half-disclosure `DIRECTION` §1 rules out for ADL. The tick's
 * `partially_liquidated` item is the observable record until the contract carries
 * a partial-liquidation event; adding one is a `packages/contracts` PR and a
 * different service's file.
 */
export function sqlPositionReducer(sql: Sql): PositionReducer {
  return {
    async reduce(positionId, input) {
      if (input.sizeClosed <= 0n) return;
      const sizeClosed = formatAmount(input.sizeClosed);
      const marginRemaining = formatAmount(input.marginRemaining < 0n ? 0n : input.marginRemaining);
      await sql`
        UPDATE trade.positions
           SET size = size - ${sizeClosed}::numeric,
               margin_current = ${marginRemaining}::numeric,
               updated_at = now()
         WHERE id = ${positionId}
           AND status = 'open'
           AND size > ${sizeClosed}::numeric
      `;
      // input.liquidationId / input.reason are for logs — the ledger already
      // carries the idempotency key that makes this rung identifiable.
      void input.liquidationId;
      void input.reason;
    },
  };
}

/**
 * Mark position row liquidated after recipes post.
 * Optional bus fan-out — honest status only.
 */
export function sqlPositionCloser(sql: Sql, bus: EventBus | null = null): PositionCloser {
  return {
    async markLiquidated(positionId, meta) {
      await sql`
        UPDATE trade.positions
        SET status = 'liquidated', closed_at = now(), updated_at = now()
        WHERE id = ${positionId} AND status = 'open'
      `;
      if (!bus) return;
      const rows = await sql<
        {
          id: string;
          user_id: string;
          market_id: string;
          side: 'long' | 'short';
          size: string;
          entry_price: string;
          leverage: string;
          margin_initial: string;
          margin_current: string | null;
          margin_mode: 'cross' | 'isolated';
          funding_paid: string;
          liq_price: string | null;
          symbol: string;
        }[]
      >`
        SELECT p.*, m.symbol
        FROM trade.positions p
        JOIN trade.markets m ON m.id = p.market_id
        WHERE p.id = ${positionId}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return;
      const size = parseAmount(row.size);
      const entry = parseAmount(row.entry_price);
      const SCALE = 10n ** 18n;
      const notional = (size * entry) / SCALE;
      const ts = new Date().toISOString();
      const collateral = parseAmount(row.margin_current ?? row.margin_initial);
      await bus.publish(
        'positionUpdated',
        {
          positionId: row.id,
          userId: row.user_id,
          marketId: row.market_id,
          symbol: row.symbol,
          status: 'liquidated',
          side: row.side,
          contracts: formatAmount(size),
          entryPrice: formatAmount(entry),
          markPrice: null,
          notional: formatAmount(notional),
          leverage: formatAmount(parseAmount(row.leverage)),
          collateral: formatAmount(collateral),
          unrealizedPnl: null,
          realizedPnl: null,
          liquidationPrice: row.liq_price != null ? formatAmount(parseAmount(row.liq_price)) : null,
          marginMode: row.margin_mode,
          fundingPaid: formatAmount(parseAmount(row.funding_paid ?? '0')),
          ts,
        },
        { idempotencyKey: `trade.position.liquidated:${row.id}:${meta.liquidationId}` },
      );
      // meta.reason is for logs only — not on positionUpdated schema
      void meta.reason;
    },
  };
}

/** Mark a dated position closed after settlement recipes post. Not liquidation. */
export function sqlDatedSettlementCloser(sql: Sql): (positionId: string) => Promise<void> {
  return async (positionId) => {
    await sql`
      UPDATE trade.positions
      SET status = 'closed', closed_at = now(), updated_at = now()
      WHERE id = ${positionId} AND status = 'open'
    `;
  };
}
