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

export async function readRateHistory(sql: Sql, poolId: string, limit?: number): Promise<RateHistory> {
  const page = assertEarnRateHistoryListLimit(limit);
  const pools = await sql<Array<{ apr_bps: string }>>`SELECT apr_bps FROM bank.earn_pools WHERE id = ${poolId}`;
  const pool = pools[0];
  if (!pool) throw new BankError(`Pool ${poolId} not found`, 'bank.pool_not_found');
  // One extra row says whether anything older exists, without counting the table.
  const rows = await sql<ChangeRow[]>`
    SELECT rate_bps, effective_at, reason FROM bank.earn_rate_changes
     WHERE pool_id = ${poolId}
     ORDER BY effective_at DESC
     LIMIT ${page + 1}
  `;
  const earlier = rows.length > page;
  return {
    poolId,
    currentBps: Number(pool.apr_bps),
    changes: rows
      .slice(0, page)
      .reverse()
      .map((row) => ({ rateBps: row.rate_bps, effectiveAt: row.effective_at, reason: row.reason })),
    earlier,
  };
}

/**
 * An approved change of a flexible pool's rate, in force from `now`: the pool's `apr_bps` and the history record move
 * together, so the history and the rate the accrual job reads can never disagree.
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
  const now = input.now ?? new Date();
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
      await recordRateChange(tx, {
        poolId: input.poolId,
        rateBps: input.rateBps,
        effectiveAt: now,
        reason: input.reason,
        approvalId: input.approvalId,
      });
      await tx`UPDATE bank.earn_pools SET apr_bps = ${input.rateBps}, updated_at = now() WHERE id = ${input.poolId}`;
      return { poolId: input.poolId, rateBps: input.rateBps, effectiveAt: now, previousBps };
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
}
