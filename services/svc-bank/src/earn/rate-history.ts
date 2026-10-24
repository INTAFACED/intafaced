import type { Sql, TransactionSql } from 'postgres';
import { transaction } from '@intafaced/db';
import { BankError } from '../errors.js';
import { assertEarnRateHistoryListLimit } from '../owner-list-limit.js';

/**
 * EARN RATE HISTORY (BK-earn-05) — every rate a pool has published, from `bank.earn_rate_changes`.
 *
 * The table is append-only (a trigger refuses UPDATE and DELETE). A pool's rate is written in two places only, each in
 * one transaction with this table: `EarnService.createPool` records the opening rate, and `setPoolRate` records an
 * approved change and moves the pool's `apr_bps` with it. The history is never built in the browser and never filled in
 * for the time before the first record: a pool opened before the table existed has no record until its first change.
 */

export interface RateChange {
  rateBps: number;
  effectiveAt: Date;
  /** The owner's reason, when one was given; the opening record has none. */
  reason: string | null;
}

export interface RateHistory {
  poolId: string;
  /** The rate the pool publishes now (`earn_pools.apr_bps`), the same figure `earn.pools` returns. */
  currentBps: number;
  /** Oldest first: the newest `limit` records. */
  changes: RateChange[];
  /** True when older records exist than this page holds. */
  earlier: boolean;
}

type Tx = Sql | TransactionSql;

interface ChangeRow {
  rate_bps: number;
  effective_at: Date;
  reason: string | null;
}

/** One record, written inside the caller's transaction. */
export async function recordRateChange(
  tx: Tx,
  input: { poolId: string; rateBps: number; effectiveAt: Date; reason: string | null; approvalId: string | null },
): Promise<void> {
  await tx`
    INSERT INTO bank.earn_rate_changes (pool_id, rate_bps, effective_at, reason, approval_id)
    VALUES (${input.poolId}, ${input.rateBps}, ${input.effectiveAt}, ${input.reason}, ${input.approvalId})
  `;
}

/**
 * One statement, so the pool's current rate and its records come from the same snapshot: a change committing between
 * two reads could otherwise show "now 1.5%" above a newest record of 1.75%. `before` pages back: only records that
 * took effect strictly earlier.
 */
export async function readRateHistory(sql: Sql, poolId: string, limit?: number, before?: Date): Promise<RateHistory> {
  const page = assertEarnRateHistoryListLimit(limit);
  // One extra row says whether anything older exists, without counting the table.
  const rows = await sql<Array<{ apr_bps: string; rate_bps: number | null; effective_at: Date | null; reason: string | null }>>`
    SELECT p.apr_bps, c.rate_bps, c.effective_at, c.reason
      FROM bank.earn_pools p
      LEFT JOIN LATERAL (
        SELECT rate_bps, effective_at, reason FROM bank.earn_rate_changes
         WHERE pool_id = p.id ${before ? sql`AND effective_at < ${before}` : sql``}
         ORDER BY effective_at DESC
         LIMIT ${page + 1}
      ) c ON true
     WHERE p.id = ${poolId}
     ORDER BY c.effective_at DESC
  `;
  const pool = rows[0];
  if (!pool) throw new BankError(`Pool ${poolId} not found`, 'bank.pool_not_found');
  const changes = rows.filter((row): row is ChangeRow & { apr_bps: string } => row.effective_at !== null);
  return {
    poolId,
    currentBps: Number(pool.apr_bps),
    changes: changes
      .slice(0, page)
      .reverse()
      .map((row) => ({ rateBps: row.rate_bps, effectiveAt: row.effective_at, reason: row.reason })),
    earlier: changes.length > page,
  };
}

/**
 * The rate one accrual day pays: the record in force when the day began (`boundary`, the day's UTC midnight). A change
 * recorded during a day is paid from the next full day, so no day is paid at a rate that was not in force all of it.
 * A pool with no record (opened before the table) pays its `apr_bps`; a day before the pool's first record (only a
 * back-dated job asks for one) pays the first record's rate, never an invented one.
 */
export async function rateForDay(tx: Tx, poolId: string, boundary: Date, poolBps: number): Promise<number> {
  const rows = await tx<Array<{ in_force: number | null; first: number | null }>>`
    SELECT
      (SELECT rate_bps FROM bank.earn_rate_changes WHERE pool_id = ${poolId} AND effective_at <= ${boundary}
        ORDER BY effective_at DESC LIMIT 1) AS in_force,
      (SELECT rate_bps FROM bank.earn_rate_changes WHERE pool_id = ${poolId}
        ORDER BY effective_at ASC LIMIT 1) AS first
  `;
  const row = rows[0];
  return row?.in_force ?? row?.first ?? poolBps;
}

/**
 * An approved change of a flexible pool's rate: the pool's `apr_bps` (the rate it publishes) and the history record move
 * together in one transaction. The record takes effect at the database's clock, strictly after the pool's last record,
 * so the history is in order whatever the app's clock says. Interest pays it from the next full UTC day
 * (`rateForDay`).
 *
 * One approval writes at most one record. A retry that brings the same approval back (the reply was lost after the
 * commit) gets the record it already wrote, not a second one; the approval itself is consumed only once upstream. A
 * fixed-term pool refuses `bank.fixed_pool_rate_locked`: its positions accrue at the pool's rate, and a term's rate is
 * its promise. A change to the rate already in force refuses `bank.pool_rate_unchanged` and records nothing.
 */
export async function setPoolRate(
  sql: Sql,
  input: { poolId: string; rateBps: number; reason: string; approvalId: string; now?: Date },
): Promise<{ poolId: string; rateBps: number; effectiveAt: Date; previousBps: number }> {
  if (!Number.isInteger(input.rateBps) || input.rateBps < 0) {
    throw new RangeError(`A rate is a non-negative whole number of basis points, got ${input.rateBps}`);
  }
  return transaction(
    sql,
    async (tx) => {
      const replay = await tx<Array<{ pool_id: string; rate_bps: number; effective_at: Date }>>`
        SELECT pool_id, rate_bps, effective_at FROM bank.earn_rate_changes WHERE approval_id = ${input.approvalId}
      `;
      const done = replay[0];
      if (done) {
        if (done.pool_id !== input.poolId || done.rate_bps !== input.rateBps) {
          throw new BankError('This approval already changed a different rate', 'bank.pool_conflict');
        }
        const previous = await tx<Array<{ rate_bps: number }>>`
          SELECT rate_bps FROM bank.earn_rate_changes
           WHERE pool_id = ${input.poolId} AND effective_at < ${done.effective_at}
           ORDER BY effective_at DESC LIMIT 1
        `;
        return {
          poolId: done.pool_id,
          rateBps: done.rate_bps,
          effectiveAt: done.effective_at,
          previousBps: previous[0]?.rate_bps ?? done.rate_bps,
        };
      }

      const pools = await tx<Array<{ kind: 'flexible' | 'fixed'; apr_bps: string }>>`
        SELECT kind, apr_bps FROM bank.earn_pools WHERE id = ${input.poolId} FOR UPDATE
      `;
      const pool = pools[0];
      if (!pool) throw new BankError(`Pool ${input.poolId} not found`, 'bank.pool_not_found');
      if (pool.kind === 'fixed') {
        throw new BankError(
          'A fixed-term pool keeps the rate it opened with; publish a new pool for a new rate',
          'bank.fixed_pool_rate_locked',
        );
      }
      const previousBps = Number(pool.apr_bps);
      if (previousBps === input.rateBps) {
        throw new BankError(`The pool already pays ${input.rateBps} bps`, 'bank.pool_rate_unchanged');
      }
      // The pool row is locked, so no other change of this pool can land between this read and the insert.
      const [clock] = await tx<Array<{ at: Date }>>`
        SELECT GREATEST(
          COALESCE(${input.now ?? null}::timestamptz, now()),
          COALESCE((SELECT max(effective_at) FROM bank.earn_rate_changes WHERE pool_id = ${input.poolId}), '-infinity'::timestamptz)
            + interval '1 millisecond'
        ) AS at
      `;
      const effectiveAt = clock!.at;
      await recordRateChange(tx, {
        poolId: input.poolId,
        rateBps: input.rateBps,
        effectiveAt,
        reason: input.reason,
        approvalId: input.approvalId,
      });
      await tx`UPDATE bank.earn_pools SET apr_bps = ${input.rateBps}, updated_at = now() WHERE id = ${input.poolId}`;
      return { poolId: input.poolId, rateBps: input.rateBps, effectiveAt, previousBps };
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
}
