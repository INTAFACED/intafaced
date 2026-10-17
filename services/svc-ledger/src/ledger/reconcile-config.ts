/**
 * Knobs of the reconciliation proof. Kept apart from `reconcile.ts` so `env.ts`
 * can read the bounds without importing the database layer.
 *
 * Neither value is a money magnitude. They are operational limits with a
 * published default (issue #4755 / ADR 2026-10-14-ledger-reconcile-snapshot-no-freeze-on-incomplete).
 */

/**
 * `statement_timeout` for ONE reconciliation run, applied with `SET LOCAL` inside
 * the proof's own transaction. The pool-wide 15 s (`LEDGER_STATEMENT_TIMEOUT_MS`)
 * stays for posts: a post that hangs must fail fast, a full-history proof must not.
 */
export const DEFAULT_RECONCILE_STATEMENT_TIMEOUT_MS = 600_000;
export const MIN_RECONCILE_STATEMENT_TIMEOUT_MS = 1_000;
export const MAX_RECONCILE_STATEMENT_TIMEOUT_MS = 3_600_000;

/**
 * Staleness reporting threshold. A proof older than this produces a fatal log
 * on every tick, but never freezes: an incomplete proof is not a mismatch.
 */
export const DEFAULT_RECONCILE_MAX_STALE_HOURS = 24;
export const MIN_RECONCILE_MAX_STALE_HOURS = 1;
export const MAX_RECONCILE_MAX_STALE_HOURS = 24 * 30;

/**
 * How many Postgres/connection failures in a row may leave posting open.
 * D-128: the next one freezes with `reconcile_unproven`. Default 3.
 */
export const DEFAULT_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE = 3;
export const MIN_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE = 1;
export const MAX_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE = 1_000;

export const RECONCILE_MISMATCH_REASON = 'reconciliation mismatch';
/** Posting halt after N consecutive proofs that never reached a verdict (D-128). */
export const RECONCILE_UNPROVEN_REASON = 'reconcile_unproven';
export const RECONCILE_ACTOR = 'reconciliation';

/**
 * The value is interpolated into `SET LOCAL statement_timeout = <n>` (SET takes
 * no bind parameters), so it must be a plain bounded integer. Anything else
 * throws before it reaches SQL.
 */
export function validReconcileStatementTimeoutMs(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_RECONCILE_STATEMENT_TIMEOUT_MS ||
    value > MAX_RECONCILE_STATEMENT_TIMEOUT_MS
  ) {
    throw new RangeError(
      `reconcile statement timeout must be an integer between ${MIN_RECONCILE_STATEMENT_TIMEOUT_MS} and ${MAX_RECONCILE_STATEMENT_TIMEOUT_MS} ms`,
    );
  }
  return value;
}

export function validReconcileMaxConsecutiveIncomplete(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE ||
    value > MAX_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE
  ) {
    throw new RangeError(
      `reconcile max consecutive incomplete must be an integer between ${MIN_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE} and ${MAX_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE}`,
    );
  }
  return value;
}

export function validReconcileMaxStaleHours(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_RECONCILE_MAX_STALE_HOURS ||
    value > MAX_RECONCILE_MAX_STALE_HOURS
  ) {
    throw new RangeError(
      `reconcile max stale hours must be an integer between ${MIN_RECONCILE_MAX_STALE_HOURS} and ${MAX_RECONCILE_MAX_STALE_HOURS}`,
    );
  }
  return value;
}
