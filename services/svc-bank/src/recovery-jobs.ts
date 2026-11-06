/**
 * In-process timer for the recovery jobs.
 *
 * POST /internal/jobs/resume-pending-loans, recover-loan-repayments and
 * resume-pending-earn re-drive rows whose ledger answer was lost. Nothing
 * called them, so a pending row stayed pending. This is the same shape as
 * svc-trade's hold-unknown sweep: an interval (default 60s, that sweep's
 * default) and a batch cap (default 50, `sweepHoldUnknown`'s default). A
 * blank interval or a blank batch disables the timer and warns at startup.
 *
 * One session advisory lock covers the whole pass, so two replicas do not
 * run it together. The lock connection is not the pool the job bodies borrow
 * from: those bodies take their own session locks. A thrown tick backs off
 * and the next tick is still scheduled. The job functions are unchanged.
 *
 * A fourth job runs when the personal-pay port is given: it announces posted
 * sends whose "money sent / money received" notice the bus never took (the
 * posted row is that notice's outbox record). A fifth, when the cash-out port
 * is given, drives on cash-outs left before their hold or the partner's
 * acceptance, so a crash there never leaves a cash-out waiting for a caller.
 */
import type { Sql } from 'postgres';
import { assertEarnResumePendingLimit, assertLoanResumePendingLimit } from './job-batch-limit.js';
import { trySessionAdvisoryLock } from './session-lock.js';

/** Same default as TRADE_HOLD_UNKNOWN_SWEEP_INTERVAL_MS. */
export const RECOVERY_INTERVAL_DEFAULT_MS = 60_000;
/** Same default as svc-trade `sweepHoldUnknown(limit = 50)`. Not the removed bank default of 100. */
export const RECOVERY_BATCH_DEFAULT = 50;
export const RECOVERY_INTERVAL_MIN_MS = 5_000;
export const RECOVERY_INTERVAL_MAX_MS = 3_600_000;
export const RECOVERY_BATCH_MAX = 1_000;

export const RECOVERY_LOCK_NAMESPACE = 'bank.recovery.jobs';
export const RECOVERY_LOCK_KEY = 'singleton';

const INTERVAL_MESSAGE = 'BANK_RECOVERY_JOBS_INTERVAL_MS must be an integer 5000–3600000, or empty to disable';
const BATCH_MESSAGE = 'BANK_RECOVERY_JOBS_BATCH_LIMIT must be an integer 1–1000, or empty to disable';

export interface RecoveryCounts {
  scanned: number;
  resolved: number;
  stillUnknown: number;
}

export interface RecoveryJobResult {
  outcome: string;
  reason?: string;
}

/**
 * `failed` stayed unresolved (the ledger did not answer, or the row was left).
 * `completed` and `open` finished the pass: the ledger answered.
 */
export function recoveryCounts(rows: readonly RecoveryJobResult[]): RecoveryCounts {
  let stillUnknown = 0;
  for (const row of rows) {
    if (row.outcome === 'failed') stillUnknown += 1;
  }
  return { scanned: rows.length, resolved: rows.length - stillUnknown, stillUnknown };
}

function integerInRange(raw: unknown, min: number, max: number, message: string): number {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
  if (text === null || !/^\d+$/.test(text)) throw new Error(message);
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(message);
  return value;
}

/** Unset → 60s. Blank → disabled (`null`). Anything else must be in range or boot refuses. */
export function parseRecoveryInterval(raw: unknown): number | null {
  if (raw === undefined || raw === null) return RECOVERY_INTERVAL_DEFAULT_MS;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  return integerInRange(raw, RECOVERY_INTERVAL_MIN_MS, RECOVERY_INTERVAL_MAX_MS, INTERVAL_MESSAGE);
}

/** Unset → 50. Blank → disabled (`null`). Never treats blank as 0 or as 100. */
export function parseRecoveryBatchLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null) return RECOVERY_BATCH_DEFAULT;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  return integerInRange(raw, 1, RECOVERY_BATCH_MAX, BATCH_MESSAGE);
}

export function recoveryBackoffMs(intervalMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return intervalMs;
  const shift = Math.min(consecutiveFailures, 6);
  return Math.min(intervalMs * 2 ** shift, RECOVERY_INTERVAL_MAX_MS);
}

interface RecoveryLoans {
  resumePending(limit: number): Promise<readonly RecoveryJobResult[]>;
  recoverRepayments(limit: number): Promise<readonly RecoveryJobResult[]>;
}

interface RecoveryEarn {
  resumePending(limit: number): Promise<readonly RecoveryJobResult[]>;
}

interface RecoveryTransferNotices {
  announceUnannounced(limit: number): Promise<readonly RecoveryJobResult[]>;
}

interface RecoveryCashOuts {
  redrive(limit: number): Promise<readonly RecoveryJobResult[]>;
}

export interface BankRecoveryJobsConfig {
  /** `null` or omitted = blank interval, timer disabled. */
  intervalMs: number | null | undefined;
  /** `null` or omitted = blank batch, timer disabled. */
  batchLimit: number | null | undefined;
}

type LockAttempt = { acquired: true } | { acquired: false };

export interface BankRecoveryJobsDeps {
  config: BankRecoveryJobsConfig;
  loans?: RecoveryLoans;
  earn?: RecoveryEarn;
  /** Posted personal sends still owed their notice. Omitted = the three money jobs only. */
  transferNotices?: RecoveryTransferNotices;
  /** Cash-outs left before their hold or the partner's acceptance. Omitted = not scheduled. */
  cashOuts?: RecoveryCashOuts;
  /** Dedicated lock connection. Not the pool the job bodies borrow from. */
  lock?: Sql;
  /** Test double. Production uses `trySessionAdvisoryLock` on `lock`. */
  tryLock?: (namespace: string, key: string, body: () => Promise<void>) => Promise<LockAttempt>;
  onWarn?: (message: string) => void;
  onError?: (name: string, err: unknown) => void;
  onResult?: (name: string, counts: RecoveryCounts) => void;
  onSkip?: (message: string) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface BankRecoveryJobsHandle {
  list(): string[];
  /** One pass, without waiting for the interval. Two handles share the advisory lock. */
  tickOnce(): Promise<void>;
  stop(): void;
}

class RecoveryPassFailed extends Error {
  constructor() {
    super('bank recovery job failed');
    this.name = 'RecoveryPassFailed';
  }
}

const JOB_NAMES = [
  'bank.recovery.resume_pending_loans',
  'bank.recovery.recover_loan_repayments',
  'bank.recovery.resume_pending_earn',
  'bank.recovery.announce_posted_transfers',
  'bank.recovery.redrive_cash_outs',
] as const;

function unrefTimer(id: ReturnType<typeof setTimeout>): void {
  if (typeof id === 'object' && id !== null && 'unref' in id && typeof id.unref === 'function') id.unref();
}

/** Start the recovery jobs, or warn and schedule nothing. */
export function startBankRecoveryJobs(deps: BankRecoveryJobsDeps): BankRecoveryJobsHandle {
  const stopped = { stop() {}, list: () => [] as string[], tickOnce: async () => {} };

  if (deps.config.intervalMs == null) {
    deps.onWarn?.('BANK_RECOVERY_JOBS_INTERVAL_MS is blank: loan and earn recovery jobs are disabled');
    return stopped;
  }
  if (deps.config.batchLimit == null) {
    deps.onWarn?.('BANK_RECOVERY_JOBS_BATCH_LIMIT is blank: loan and earn recovery jobs are disabled');
    return stopped;
  }
  if (!deps.loans || !deps.earn) throw new Error('recovery jobs need loans and earn');
  if (!deps.tryLock && !deps.lock) throw new Error('recovery jobs need a lock connection');

  const intervalMs = deps.config.intervalMs;
  const loanBatch = assertLoanResumePendingLimit(deps.config.batchLimit);
  const earnBatch = assertEarnResumePendingLimit(deps.config.batchLimit);
  const noticeBatch = deps.config.batchLimit;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const loans = deps.loans;
  const earn = deps.earn;
  const tryLock =
    deps.tryLock ??
    (async (namespace: string, key: string, body: () => Promise<void>) => {
      const result = await trySessionAdvisoryLock(deps.lock as Sql, namespace, key, body);
      return result.acquired ? { acquired: true as const } : { acquired: false as const };
    });

  const jobs: Array<{ name: (typeof JOB_NAMES)[number]; run: () => Promise<readonly RecoveryJobResult[]> }> = [
    { name: JOB_NAMES[0], run: () => loans.resumePending(loanBatch) },
    { name: JOB_NAMES[1], run: () => loans.recoverRepayments(loanBatch) },
    { name: JOB_NAMES[2], run: () => earn.resumePending(earnBatch) },
  ];
  const transferNotices = deps.transferNotices;
  if (transferNotices) jobs.push({ name: JOB_NAMES[3], run: () => transferNotices.announceUnannounced(noticeBatch) });
  const cashOuts = deps.cashOuts;
  if (cashOuts) jobs.push({ name: JOB_NAMES[4], run: () => cashOuts.redrive(noticeBatch) });

  let stoppedFlag = false;
  let running = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    if (stoppedFlag) return;
    const delay = recoveryBackoffMs(intervalMs, failures);
    const id = setTimeoutFn(() => {
      void fire();
    }, delay);
    unrefTimer(id);
    timer = id;
  };

  const pass = async () => {
    try {
      const outcome = await tryLock(RECOVERY_LOCK_NAMESPACE, RECOVERY_LOCK_KEY, async () => {
        let failed = false;
        for (const job of jobs) {
          try {
            const rows = await job.run();
            deps.onResult?.(job.name, recoveryCounts(rows));
          } catch (err) {
            failed = true;
            try {
              deps.onError?.(job.name, err);
            } catch {
              // A logger failure must not cancel the rest of the pass or the next tick.
            }
          }
        }
        if (failed) throw new RecoveryPassFailed();
      });
      if (!outcome.acquired) deps.onSkip?.('bank recovery jobs skipped: another replica holds the lock');
    } catch (err) {
      if (!(err instanceof RecoveryPassFailed)) {
        try {
          deps.onError?.('bank.recovery.jobs', err);
        } catch {
          // A logger failure must not stop the next tick.
        }
      }
      throw err;
    }
  };

  const fire = async () => {
    if (stoppedFlag || running) return;
    running = true;
    let failed = false;
    try {
      await pass();
    } catch {
      failed = true;
    } finally {
      running = false;
      failures = failed ? failures + 1 : 0;
      arm();
    }
  };

  arm();

  return {
    list: () => jobs.map((job) => job.name),
    async tickOnce() {
      if (timer !== undefined) {
        clearTimeoutFn(timer);
        timer = undefined;
      }
      await fire();
    },
    stop() {
      stoppedFlag = true;
      if (timer !== undefined) clearTimeoutFn(timer);
      timer = undefined;
    },
  };
}
