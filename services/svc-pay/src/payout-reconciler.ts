import type { Sql } from 'postgres';
import type { PayService } from './payment-service.js';

/**
 * Production caller for `PayService.reconcileDispatchedPayout`.
 *
 * A payout that wrote its `dispatched` marker and then crashed (or lost the rail answer) keeps its hold until
 * someone asks the rail about the original key. This pass finds those settlements and asks, one at a time. It never
 * posts to the ledger itself and never picks a rail answer: `reconcileDispatchedPayout` does that under the payout
 * lock with business-key idempotency, so a crash between the rail answer and the ledger post is finished by the
 * next pass, not repeated.
 *
 * No invented magnitude: the tick interval and the batch size are owner-published. Blank means the job is off and
 * says which setting blocks it (`pay.payout_reconcile_interval_unset`, `pay.payout_reconcile_batch_limit_unset`).
 */

export type PayoutReconcilerErrorCode = 'pay.payout_reconcile_interval_unset' | 'pay.payout_reconcile_batch_limit_unset';

export class PayoutReconcilerError extends Error {
  constructor(
    message: string,
    readonly code: PayoutReconcilerErrorCode,
  ) {
    super(message);
    this.name = 'PayoutReconcilerError';
  }
}

export function publishedPayoutReconcileIntervalMs(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new PayoutReconcilerError(
      'PAY_PAYOUT_RECONCILE_INTERVAL_MS is not set; dispatched payouts stay held until the owner publishes an interval',
      'pay.payout_reconcile_interval_unset',
    );
  }
  return value;
}

export function publishedPayoutReconcileBatchLimit(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new PayoutReconcilerError(
      'PAY_PAYOUT_RECONCILE_BATCH_LIMIT is not set; the payout reconciler does not pick a batch size',
      'pay.payout_reconcile_batch_limit_unset',
    );
  }
  return value;
}

export type PayoutReconcilerConfig =
  | { readonly mode: 'off'; readonly blocker: PayoutReconcilerErrorCode; readonly message: string }
  | { readonly mode: 'on'; readonly intervalMs: number; readonly batchLimit: number };

/** Off with a named blocker when either setting is blank; never a default. */
export function resolvePayoutReconcilerConfig(input: { intervalMs?: number | null; batchLimit?: number | null }): PayoutReconcilerConfig {
  try {
    const intervalMs = publishedPayoutReconcileIntervalMs(input.intervalMs);
    const batchLimit = publishedPayoutReconcileBatchLimit(input.batchLimit);
    return { mode: 'on', intervalMs, batchLimit };
  } catch (err) {
    if (err instanceof PayoutReconcilerError) return { mode: 'off', blocker: err.code, message: err.message };
    throw err;
  }
}

export interface PayoutReconcileReport {
  readonly examined: number;
  readonly paidOut: number;
  readonly reversed: number;
  /** The rail could not say (or has no status query): the hold stays and the next pass asks again. */
  readonly stillUnknown: number;
  /** Any other failure; counted, and the pass moves on to the next settlement. */
  readonly failed: ReadonlyArray<{ settlementId: string; code: string }>;
}

/** Settlements whose current admission wrote `dispatched` and has neither `settled` nor `reversed`. */
export async function listDispatchedPayouts(sql: Sql, limit: number): Promise<string[]> {
  const rows = await sql<Array<{ settlement_id: string }>>`
    SELECT a.settlement_id
      FROM pay.payout_admissions a
      JOIN pay.settlements s ON s.id = a.settlement_id AND s.payout_attempts = a.attempt
     WHERE s.status <> 'paid_out'
       AND EXISTS (SELECT 1 FROM pay.payout_outcomes o WHERE o.admission_id = a.id AND o.kind = 'dispatched')
       AND NOT EXISTS (SELECT 1 FROM pay.payout_outcomes o WHERE o.admission_id = a.id AND o.kind IN ('settled', 'reversed'))
     ORDER BY a.admitted_at, a.id
     LIMIT ${limit}
  `;
  return rows.map((row) => row.settlement_id);
}

/** One bounded pass. One settlement's failure is counted; the rest still run. */
export async function runPayoutReconcilePass(
  sql: Sql,
  pay: Pick<PayService, 'reconcileDispatchedPayout'>,
  input: { batchLimit: number | null | undefined },
): Promise<PayoutReconcileReport> {
  const limit = publishedPayoutReconcileBatchLimit(input.batchLimit);
  const ids = await listDispatchedPayouts(sql, limit);
  let paidOut = 0;
  let reversed = 0;
  let stillUnknown = 0;
  const failed: Array<{ settlementId: string; code: string }> = [];
  for (const settlementId of ids) {
    try {
      const settlement = await pay.reconcileDispatchedPayout(settlementId);
      if (settlement.status === 'paid_out') paidOut += 1;
      else if (settlement.status === 'failed') reversed += 1;
    } catch (err) {
      const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'pay.failed';
      if (code === 'pay.rail_outcome_unknown') stillUnknown += 1;
      else failed.push({ settlementId, code });
    }
  }
  return { examined: ids.length, paidOut, reversed, stillUnknown, failed };
}

export interface PayoutReconcilerLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * The scheduled job. Returns null (and logs the named blocker) when a setting is blank. A tick that finds the last
 * one still running skips; the payout lock already makes a second replica safe.
 */
export function startPayoutReconciler(
  sql: Sql,
  pay: Pick<PayService, 'reconcileDispatchedPayout'>,
  config: { intervalMs?: number | null; batchLimit?: number | null },
  log: PayoutReconcilerLog,
): { stop(): void } | null {
  const resolved = resolvePayoutReconcilerConfig(config);
  if (resolved.mode === 'off') {
    log.warn({ code: resolved.blocker }, `payout reconciler off: ${resolved.message}`);
    return null;
  }
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runPayoutReconcilePass(sql, pay, { batchLimit: resolved.batchLimit })
      .then((report) => {
        if (report.examined > 0) log.info(report, 'payout reconcile pass');
        if (report.failed.length > 0) log.warn({ failed: report.failed }, 'payout reconcile left settlements failed; retry next tick');
      })
      .catch((err) => log.warn({ err }, 'payout reconcile pass failed'))
      .finally(() => {
        running = false;
      });
  }, resolved.intervalMs);
  timer.unref?.();
  log.info({ intervalMs: resolved.intervalMs, batchLimit: resolved.batchLimit }, 'payout reconciler started');
  return { stop: () => clearInterval(timer) };
}
