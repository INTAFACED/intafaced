import type { Sql } from 'postgres';
import type { UserMoneyService, WithdrawalRecord } from '../user-money-service.js';
import { WITHDRAWAL_CANCELED_CODE } from './status.js';

/**
 * The advance worker for sends out of the platform (W-withdraw-06).
 *
 * A create books the hold and answers `held`. This pass takes each held send on: it sends it on the chain if nothing is
 * journalled for its attempt, asks the chain how deep an accepted send is, settles it at the owner's minimum depth, and puts
 * a refused send back. It never posts to the ledger itself: `advanceWithdrawal` is `withdraw` on the row's own terms, under
 * the same payout lock and business keys as the create, so a crash anywhere is finished by the next pass, never repeated.
 *
 * No invented magnitude: the tick interval and the batch size are owner-published. Blank means the job is off and says which
 * setting blocks it (`pay.withdraw_advance_interval_unset`, `pay.withdraw_advance_batch_limit_unset`); a create then
 * dispatches in the request as before.
 */

export type WithdrawAdvanceErrorCode = 'pay.withdraw_advance_interval_unset' | 'pay.withdraw_advance_batch_limit_unset';

export class WithdrawAdvanceError extends Error {
  constructor(
    message: string,
    readonly code: WithdrawAdvanceErrorCode,
  ) {
    super(message);
    this.name = 'WithdrawAdvanceError';
  }
}

export type WithdrawAdvanceConfig =
  | { readonly mode: 'off'; readonly blocker: WithdrawAdvanceErrorCode; readonly message: string }
  | { readonly mode: 'on'; readonly intervalMs: number; readonly batchLimit: number };

function published(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 1;
}

/** Off with a named blocker when either setting is blank; never a default. */
export function resolveWithdrawAdvanceConfig(input: { intervalMs?: number | null; batchLimit?: number | null }): WithdrawAdvanceConfig {
  if (!published(input.intervalMs)) {
    return {
      mode: 'off',
      blocker: 'pay.withdraw_advance_interval_unset',
      message: 'PAY_WITHDRAW_ADVANCE_INTERVAL_MS is not set; sends out of the platform are dispatched in the request',
    };
  }
  if (!published(input.batchLimit)) {
    return {
      mode: 'off',
      blocker: 'pay.withdraw_advance_batch_limit_unset',
      message: 'PAY_WITHDRAW_ADVANCE_BATCH_LIMIT is not set; the withdrawal advance worker does not pick a batch size',
    };
  }
  return { mode: 'on', intervalMs: input.intervalMs, batchLimit: input.batchLimit };
}

/** Resume after this row (creation time as text keeps microseconds). */
export interface WithdrawAdvanceCursor {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * Held sends out of the platform, oldest first, after `after`: on a network, moved into `held` under the journalling code
 * (so every send of the attempt is journalled before the rail is asked), and not a cancel in flight (the cancel finishes it).
 */
export async function listHeldSends(
  sql: Sql,
  limit: number,
  after: WithdrawAdvanceCursor | null = null,
): Promise<Array<{ withdrawalId: string; cursor: WithdrawAdvanceCursor }>> {
  const afterAt = after?.createdAt ?? '-infinity';
  const afterId = after?.id ?? '00000000-0000-0000-0000-000000000000';
  const rows = await sql<Array<{ id: string; created_at: string }>>`
    SELECT w.id::text AS id, w.created_at::text AS created_at
      FROM pay.withdrawals w
     WHERE w.status = 'held'
       AND w.network_id IS NOT NULL
       AND w.dispatch_journaled = true
       AND w.failure_code IS DISTINCT FROM ${WITHDRAWAL_CANCELED_CODE}
       AND (w.created_at, w.id) > (${afterAt}::text::timestamptz, ${afterId}::text::uuid)
     ORDER BY w.created_at, w.id
     LIMIT ${limit}
  `;
  return rows.map((row) => ({ withdrawalId: row.id, cursor: { createdAt: row.created_at, id: row.id } }));
}

export interface WithdrawAdvanceReport {
  readonly examined: number;
  readonly settled: number;
  /** The rail refused the send; its hold went back. */
  readonly reversed: number;
  /** Sent and not yet deep enough, or the chain could not say: the hold stays and the next pass asks again. */
  readonly waiting: number;
  /** Any other failure; counted, and the pass moves on to the next withdrawal. */
  readonly failed: ReadonlyArray<{ withdrawalId: string; code: string }>;
  readonly nextCursor: WithdrawAdvanceCursor | null;
}

/**
 * One bounded pass. One withdrawal's failure is counted; the rest still run. A full page hands back a cursor so a send the
 * chain cannot resolve does not starve newer ones behind it; a short page returns null and the next pass starts again.
 */
export async function runWithdrawAdvancePass(
  sql: Sql,
  money: Pick<UserMoneyService, 'advanceWithdrawal'>,
  input: { batchLimit: number; after?: WithdrawAdvanceCursor | null },
): Promise<WithdrawAdvanceReport> {
  const rows = await listHeldSends(sql, input.batchLimit, input.after ?? null);
  let settled = 0;
  let reversed = 0;
  let waiting = 0;
  const failed: Array<{ withdrawalId: string; code: string }> = [];
  for (const { withdrawalId } of rows) {
    try {
      const record: WithdrawalRecord = await money.advanceWithdrawal(withdrawalId);
      if (record.status === 'sent') settled += 1;
      else waiting += 1;
    } catch (err) {
      const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'pay.failed';
      if (code === 'pay.rail_failed') reversed += 1;
      else if (code === 'pay.rail_outcome_unknown') waiting += 1;
      else failed.push({ withdrawalId, code });
    }
  }
  const last = rows[rows.length - 1];
  return { examined: rows.length, settled, reversed, waiting, failed, nextCursor: rows.length >= input.batchLimit && last ? last.cursor : null };
}

export interface WithdrawAdvanceLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * The scheduled job. Returns null (and logs the named blocker) when a setting is blank. A tick that finds the last one still
 * running skips; the payout lock already makes a second replica safe.
 */
export function startWithdrawAdvanceWorker(
  sql: Sql,
  money: Pick<UserMoneyService, 'advanceWithdrawal'>,
  config: WithdrawAdvanceConfig,
  log: WithdrawAdvanceLog,
): { stop(): void } | null {
  if (config.mode === 'off') {
    log.warn({ code: config.blocker }, `withdrawal advance worker off: ${config.message}`);
    return null;
  }
  let running = false;
  let cursor: WithdrawAdvanceCursor | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runWithdrawAdvancePass(sql, money, { batchLimit: config.batchLimit, after: cursor })
      .then((report) => {
        cursor = report.nextCursor;
        if (report.settled > 0 || report.reversed > 0) log.info(report, 'withdrawal advance pass');
        if (report.failed.length > 0) log.warn({ failed: report.failed }, 'withdrawal advance left withdrawals failed; retry next tick');
      })
      .catch((err) => log.warn({ err }, 'withdrawal advance pass failed'))
      .finally(() => {
        running = false;
      });
  }, config.intervalMs);
  timer.unref?.();
  log.info({ intervalMs: config.intervalMs, batchLimit: config.batchLimit }, 'withdrawal advance worker started');
  return { stop: () => clearInterval(timer) };
}
