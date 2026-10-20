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
import { transaction } from '@intafaced/db';
import type { LiquidationAttemptStore, PositionCloser, PositionReducer } from './liquidation-tick.js';
import {
  decodeRungPlan,
  encodeRungPlan,
  type ApplyRungResult,
  type RungAlert,
  type BeginRungInput,
  type BeginRungResult,
  type EncodedRungPlan,
  type LiquidationRungStore,
  type RungKind,
  type RungRecord,
  type RungState,
} from './liquidation-rungs.js';
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
    async freezeRate(periodId, rate) {
      // First writer freezes the rate; every later run (replay, concurrent tick,
      // oracle republish at a new rate) reads the same one back.
      await sql`
        INSERT INTO trade.funding_period_rates (period_id, rate)
        VALUES (${periodId}, ${rate})
        ON CONFLICT (period_id) DO NOTHING
      `;
      const rows = await sql<{ rate: string }[]>`
        SELECT rate FROM trade.funding_period_rates WHERE period_id = ${periodId} LIMIT 1
      `;
      const row = rows[0];
      if (!row) {
        // Never fall back to the oracle rate — that is the defect this table closes.
        throw new Error(`funding rate freeze for ${periodId} produced no row — refusing oracle-rate fallback`);
      }
      return row.rate;
    },
    async peekRate(periodId) {
      const rows = await sql<{ rate: string }[]>`
        SELECT rate FROM trade.funding_period_rates WHERE period_id = ${periodId} LIMIT 1
      `;
      return rows[0]?.rate ?? null;
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
      if (input.sizeClosed <= 0n) return false;
      const sizeClosed = formatAmount(input.sizeClosed);
      const marginRemaining = formatAmount(input.marginRemaining < 0n ? 0n : input.marginRemaining);
      const moved = await sql`
        UPDATE trade.positions
           SET size = size - ${sizeClosed}::numeric,
               margin_current = ${marginRemaining}::numeric,
               updated_at = now()
         WHERE id = ${positionId}
           AND status = 'open'
           AND size > ${sizeClosed}::numeric
        RETURNING id
      `;
      // input.liquidationId / input.reason are for logs — the ledger already
      // carries the idempotency key that makes this rung identifiable.
      void input.liquidationId;
      void input.reason;
      // A row that did not match the predicate is a no-op the caller must see:
      // the tranche's loss is booked and the position did not shrink.
      return moved.length > 0;
    },
  };
}

/**
 * Mark position row liquidated after recipes post.
 * Optional bus fan-out — honest status only.
 */
export function sqlPositionCloser(sql: Sql, bus: EventBus | null = null): PositionCloser {
  /** The bus fan-out only — the row is already `liquidated`. */
  async function announceLiquidated(positionId: string, meta: { liquidationId: string; reason: string }): Promise<void> {
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
  }
  return {
    async markLiquidated(positionId, meta) {
      await sql`
        UPDATE trade.positions
        SET status = 'liquidated', closed_at = now(), updated_at = now()
        WHERE id = ${positionId} AND status = 'open'
      `;
      await announceLiquidated(positionId, meta);
    },
    announceLiquidated,
  };
}

interface RungRow {
  rung_id: string;
  position_id: string;
  liquidation_id: string;
  kind: RungKind;
  from_size: string;
  from_margin: string;
  plan: EncodedRungPlan;
  state: RungState;
  plan_version: number;
  margin_drift: string;
}

function rungFromRow(row: RungRow): RungRecord {
  return {
    rungId: row.rung_id,
    positionId: row.position_id,
    liquidationId: row.liquidation_id,
    kind: row.kind,
    fromSize: parseAmount(row.from_size),
    fromMargin: parseAmount(row.from_margin),
    plan: decodeRungPlan(row.plan),
    state: row.state,
    planVersion: row.plan_version,
    marginDrift: parseAmount(row.margin_drift),
  };
}

/**
 * The rung state machine on Postgres — see `liquidation-rungs.ts`.
 *
 * EVERY ROW-STATE CHECK IS UNDER `SELECT … FOR UPDATE` ON THE POSITION ROW. A
 * rung is created and applied only while holding that lock, so for one position
 * "is there a live rung?", "is the row still what the decision read?" and "move
 * the row, set the rung applied" are each a single indivisible step. READ
 * COMMITTED is correct here for the reason `transaction` documents: the lock
 * establishes the total order, so transactions queue instead of aborting.
 *
 * The partial unique index `liquidation_rungs_one_live_idx` is the backstop
 * (a second live rung for one position cannot exist whatever the code does).
 */
export function sqlLiquidationRungStore(sql: Sql): LiquidationRungStore {
  async function liveIn(tx: Sql, positionId: string): Promise<RungRecord | null> {
    const rows = await tx<RungRow[]>`
      SELECT rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state, plan_version, margin_drift
        FROM trade.liquidation_rungs
       WHERE position_id = ${positionId} AND state IN ('planned', 'posted')
       LIMIT 1
    `;
    return rows[0] ? rungFromRow(rows[0]) : null;
  }

  async function beginLocked(input: BeginRungInput): Promise<BeginRungResult> {
    return transaction(
      sql,
      async (tx) => {
        const locked = await tx<{ status: string; size_ok: boolean; margin_ok: boolean }[]>`
          SELECT status,
                 size = ${formatAmount(input.fromSize)}::numeric AS size_ok,
                 margin_current = ${formatAmount(input.fromMargin)}::numeric AS margin_ok
            FROM trade.positions
           WHERE id = ${input.positionId}
             FOR UPDATE
        `;
        // A live rung wins whatever the row looks like now: it is the one that
        // may already have booked a loss, and it is what must be finished.
        const existing = await liveIn(tx, input.positionId);
        if (existing) return { status: 'live' as const, rung: existing };

        const row = locked[0];
        if (!row || row.status !== 'open' || !row.size_ok || !row.margin_ok) return { status: 'changed' as const };
        // A planned ADL pair is about to move this row (adl-pairing.ts); the next tick drives it first.
        const [adl] = await tx<{ planned: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM trade.futures_adl_pairs q
             WHERE q.state = 'planned' AND (q.bankrupt_position_id::text = ${input.positionId} OR q.candidate_position_id::text = ${input.positionId})
          ) AS planned
        `;
        if (adl?.planned) return { status: 'changed' as const };

        const inserted = await tx<RungRow[]>`
          INSERT INTO trade.liquidation_rungs (rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state)
          VALUES (
            ${input.rungId}, ${input.positionId}, ${input.liquidationId}, ${input.kind},
            ${formatAmount(input.fromSize)}::numeric, ${formatAmount(input.fromMargin)}::numeric,
            ${tx.json(encodeRungPlan(input.plan) as never)}, 'planned'
          )
          RETURNING rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state, plan_version, margin_drift
        `;
        return { status: 'created' as const, rung: rungFromRow(inserted[0]!) };
      },
      { isolation: 'read committed' },
    );
  }

  return {
    async findLive(positionId) {
      return liveIn(sql, positionId);
    },

    async begin(input): Promise<BeginRungResult> {
      try {
        return await beginLocked(input);
      } catch (err) {
        // The row lock makes this unreachable through this code path; the unique
        // index is the backstop, and a writer that raced past the lock (a manual
        // insert, a future second writer) still converges on the winner's rung.
        if ((err as { code?: string } | null)?.code !== '23505') throw err;
        const winner = await liveIn(sql, input.positionId);
        if (!winner) throw err;
        return { status: 'live', rung: winner };
      }
    },

    async amendPlan(rungId, plan, expectedVersion) {
      // Compare-and-set on plan_version: the amendment applies only to the plan its
      // author read. A second worker amending from the same read matches no row.
      const rows = await sql<{ plan_version: number }[]>`
        UPDATE trade.liquidation_rungs
           SET plan = ${sql.json(encodeRungPlan(plan) as never)}, plan_version = plan_version + 1, updated_at = now()
         WHERE rung_id = ${rungId} AND state = 'planned' AND plan_version = ${expectedVersion}
        RETURNING plan_version
      `;
      return rows[0] ? rows[0].plan_version : null;
    },

    async markPosted(rungId) {
      await sql`
        UPDATE trade.liquidation_rungs
           SET state = 'posted', updated_at = now()
         WHERE rung_id = ${rungId} AND state = 'planned'
      `;
    },

    async apply(positionId, rungId): Promise<ApplyRungResult> {
      return transaction(
        sql,
        async (tx): Promise<ApplyRungResult> => {
          // The position row first: that is the order every writer takes.
          const locked = await tx<{ status: string; size: string; margin_current: string }[]>`
            SELECT status, size, margin_current FROM trade.positions WHERE id = ${positionId} FOR UPDATE
          `;
          // Read AFTER the lock, so a concurrent apply's 'applied' is visible here.
          const found = await tx<RungRow[]>`
            SELECT rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state, plan_version, margin_drift
              FROM trade.liquidation_rungs
             WHERE rung_id = ${rungId} AND position_id = ${positionId}
          `;
          const rungRow = found[0];
          if (!rungRow) return { status: 'not_live' };
          if (rungRow.state === 'applied') return { status: 'already_applied' };
          if (rungRow.state === 'abandoned' || rungRow.state === 'resolved') return { status: 'not_live' };
          const rung = rungFromRow(rungRow);

          const abandon = async (reason: 'row_changed' | 'row_missing' | 'reduction_no_op'): Promise<ApplyRungResult> => {
            await tx`
              UPDATE trade.liquidation_rungs SET state = 'abandoned', updated_at = now() WHERE rung_id = ${rungId}
            `;
            return { status: 'abandoned', reason };
          };

          const row = locked[0];
          if (!row) return abandon('row_missing');
          if (row.status !== 'open') return abandon('row_changed');

          let drift = 0n;
          let alert: RungAlert | undefined;

          if (rung.kind === 'partial') {
            const sizeClosed = formatAmount(rung.plan.sizeClosed);
            const marginTaken = formatAmount(rung.plan.marginTaken);
            // THE LOSS IS BOOKED, SO THE ROW MOVES BY A DELTA. Funding, the trader
            // adding or taking margin, a partial close — any of them may have moved
            // the row since the decision, and none of them un-books the loss. The
            // only guard is the one `positions_size_positive_ck` needs: the tranche
            // must be strictly smaller than what is left.
            const moved = await tx`
              UPDATE trade.positions
                 SET size = size - ${sizeClosed}::numeric,
                     margin_current = GREATEST(margin_current - ${marginTaken}::numeric, 0),
                     updated_at = now()
               WHERE id = ${positionId}
                 AND status = 'open'
                 AND size > ${sizeClosed}::numeric
               RETURNING id
            `;
            if (moved.length === 0) return abandon('reduction_no_op');
            // THE FLOOR AT ZERO MUST NOT HIDE A SHORTFALL. If the row held less margin
            // than the loss took (funding took it first), the rung still applies — the
            // loss is booked and the size must shrink — but the shortfall is recorded
            // and raised, not swallowed by GREATEST.
            const shortfall = parseAmount(row.margin_current) - rung.plan.marginTaken;
            if (shortfall < 0n) {
              drift = shortfall;
              alert = { code: 'trade.liquidation_margin_clipped', amount: shortfall };
            }
          } else {
            // THE LOSS AND THE STORED RELEASE ARE BOOKED, so the row closes if it is
            // still the SIZE they were computed for — whatever its margin did since.
            // Abandoning on a margin change (the first version) left a position the
            // ledger had fully liquidated open and tradable. The margin difference is
            // recorded and raised for an operator instead.
            const closed = await tx<{ margin_current: string }[]>`
              UPDATE trade.positions
                 SET status = 'liquidated', closed_at = now(), updated_at = now()
               WHERE id = ${positionId}
                 AND status = 'open'
                 AND size = ${formatAmount(rung.fromSize)}::numeric
               RETURNING margin_current
            `;
            if (closed.length === 0) return abandon('row_changed');
            drift = parseAmount(closed[0]!.margin_current) - rung.fromMargin;
            if (drift !== 0n) alert = { code: 'trade.liquidation_margin_drift', amount: drift };
          }

          await tx`
            UPDATE trade.liquidation_rungs
               SET state = 'applied', margin_drift = ${formatAmount(drift)}::numeric, updated_at = now()
             WHERE rung_id = ${rungId}
          `;
          return alert ? { status: 'applied', alert } : { status: 'applied' };
        },
        { isolation: 'read committed' },
      );
    },

    async isParked(positionId) {
      const rows = await sql<{ state: string }[]>`
        SELECT state FROM trade.liquidation_rungs
         WHERE position_id = ${positionId}
         ORDER BY created_at DESC, rung_id DESC
         LIMIT 1
      `;
      return rows[0]?.state === 'abandoned';
    },

    async listUnannounced(limit) {
      const rows = await sql<RungRow[]>`
        SELECT rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state, plan_version, margin_drift
          FROM trade.liquidation_rungs
         WHERE kind = 'closing' AND state = 'applied' AND announced_at IS NULL
         ORDER BY created_at
         LIMIT ${limit}
      `;
      return rows.map(rungFromRow);
    },

    async markAnnounced(rungId) {
      await sql`
        UPDATE trade.liquidation_rungs SET announced_at = now(), updated_at = now()
         WHERE rung_id = ${rungId} AND announced_at IS NULL
      `;
    },
  };
}

/**
 * Mark a dated position closed after settlement recipes post. Not liquidation.
 *
 * NOT GATED ON A LIVE RUNG, ON PURPOSE. By the time this runs the settlement has already posted the
 * position's money (`runDatedFuturesSettlementJob`), so refusing to close the row would leave a
 * settled position open and tradable. The gate that keeps a rung and a settlement from meeting is
 * upstream, where nothing has posted yet: `sqlDatedSettlementPositionLoader` does not hand
 * settlement a position that has a live rung or is parked.
 */
export function sqlDatedSettlementCloser(sql: Sql): (positionId: string) => Promise<void> {
  return async (positionId) => {
    await sql`
      UPDATE trade.positions
      SET status = 'closed', closed_at = now(), updated_at = now()
      WHERE id = ${positionId} AND status = 'open'
    `;
  };
}
