import { LedgerError } from '@intafaced/ledger-client';
import { reconcileErrorCode, type LastVerified, type ScheduledReconcileResult } from './reconcile.js';
import {
  DEFAULT_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE,
  RECONCILE_ACTOR,
  RECONCILE_MISMATCH_REASON,
  RECONCILE_UNPROVEN_REASON,
  validReconcileMaxConsecutiveIncomplete,
} from './reconcile-config.js';

/**
 * Hourly timer seam.
 *
 * A completed mismatch freezes as `reconciliation mismatch` (the snapshot runner
 * writes that halt before it returns). Any other throw, except
 * `ledger.reconcile_freeze_failed`, is incomplete (phase `tick` when the runner
 * itself threw). It alerts and counts toward N. It does not freeze as a mismatch.
 *
 * Every incomplete run emits an alert. The streak is the larger of this process's
 * count and the durable count of incomplete rows after the latest ok or mismatch
 * (D-128, default N=3). A failed durable read logs fatal and uses the in-memory
 * count. Backoff uses the in-memory count. At N, posting freezes with reason
 * `reconcile_unproven`.
 *
 * Staleness is reported on every tick, including backoff. An old or absent
 * proof by itself never changes the posting switch.
 */

const FROZEN_LOG = 'LEDGER RECONCILIATION FAILED — posting frozen, operator attention required';
const INCOMPLETE_LOG = 'LEDGER RECONCILIATION INCOMPLETE — the book was NOT verified and NOT frozen, operator attention required';
const UNPROVEN_LOG = 'LEDGER RECONCILIATION UNPROVEN — posting frozen after consecutive incomplete runs, operator attention required';
const STALE_LOG = 'LEDGER RECONCILIATION STALE — the book is NOT verified, posting unchanged, operator attention required';
const ALERT_FAILED_LOG = 'LEDGER RECONCILIATION ALERT FAILED — the incomplete run was not announced';
const STREAK_UNREADABLE_LOG = 'LEDGER RECONCILIATION STREAK UNREADABLE — using the in-memory incomplete count';

/** What an incomplete run announces. No money figures: the proof did not finish. */
export interface ReconcileIncompleteAlert {
  readonly errorCode: string;
  readonly phase: 'start' | 'tip' | 'proof' | 'snapshot' | 'tick';
  readonly consecutiveIncomplete: number;
  readonly runId: string | null;
}

export interface ReconcileTickLog {
  fatal(obj: object, msg: string): void;
  info?(obj: object, msg: string): void;
}

interface TickLedger {
  freeze(reason: string, actor: string): Promise<unknown>;
  /** Present on `LedgerService`. A publish throw can land after the switch commits. */
  status?(): Promise<{ postingEnabled: boolean }>;
  /** Present on `LedgerService`. Without it staleness reporting is off. */
  lastVerified?(): Promise<LastVerified>;
  /** Present on `LedgerService`. Announces every incomplete run, including the one that freezes. */
  alertReconciliationIncomplete?(alert: ReconcileIncompleteAlert): Promise<void>;
  /**
   * Present on `LedgerService`. Incomplete rows after the latest ok or mismatch.
   * Without it the tick counts only this process.
   */
  consecutiveIncompleteRuns?(): Promise<number>;
  /**
   * Operator controls that are due (OPS-reconciliation-01). A throw here does not
   * freeze posting: a configured control is not the built-in invariant.
   */
  runDueReconciliationControls?(): Promise<void>;
}

/** Mutable per-process state. Pass one object for the life of the timer. */
export interface ReconcileTickState {
  consecutiveIncomplete: number;
  /** Ticks still to skip before the next attempt. Backoff lives ACROSS ticks, never inside one. */
  skipTicks: number;
  readonly bootedAt: Date;
}

export function createReconcileTickState(now: Date = new Date()): ReconcileTickState {
  return { consecutiveIncomplete: 0, skipTicks: 0, bootedAt: now };
}

export interface ReconcileTickOptions {
  /** Report staleness when the last `ok` run is older than this. Omitted: no threshold. */
  readonly maxStaleHours?: number;
  /**
   * Freeze with `reconcile_unproven` once this many incomplete runs have landed
   * in a row. Omitted: the published default (3).
   */
  readonly maxConsecutiveIncomplete?: number;
  readonly state?: ReconcileTickState;
  readonly now?: () => Date;
}

/** After the n-th consecutive incomplete run: skip 0, 1, 3, 7, then 8 ticks. A cadence-hourly job retries hourly at first. */
export function backoffTicks(consecutiveIncomplete: number): number {
  if (consecutiveIncomplete <= 1) return 0;
  return Math.min(2 ** (consecutiveIncomplete - 1) - 1, 8);
}

async function alreadyHalted(ledger: TickLedger): Promise<boolean> {
  if (!ledger.status) return false;
  try {
    const status = await ledger.status();
    return status.postingEnabled === false;
  } catch {
    return false;
  }
}

/**
 * Freeze under `reconciliation`, tolerating an operator freeze already standing.
 * Same rule as `LedgerService.reconcile`: a publish failure after the switch
 * commits is also a halt. Anything else did not freeze the book, so it throws.
 */
async function freezeAsReconciliation(ledger: TickLedger, reason: string): Promise<void> {
  try {
    await ledger.freeze(reason, RECONCILE_ACTOR);
  } catch (freezeErr) {
    const attributed = freezeErr instanceof LedgerError && freezeErr.code === 'ledger.freeze_attributed';
    if (!attributed && !(await alreadyHalted(ledger))) throw freezeErr;
  }
}

async function announcedStreak(state: ReconcileTickState, ledger: TickLedger, log: ReconcileTickLog): Promise<number> {
  if (!ledger.consecutiveIncompleteRuns) return state.consecutiveIncomplete;
  try {
    const durable = await ledger.consecutiveIncompleteRuns();
    if (typeof durable !== 'number' || !Number.isInteger(durable) || durable < 0) {
      log.fatal({ durable }, STREAK_UNREADABLE_LOG);
      return state.consecutiveIncomplete;
    }
    return Math.max(state.consecutiveIncomplete, durable);
  } catch (err) {
    log.fatal({ err }, STREAK_UNREADABLE_LOG);
    return state.consecutiveIncomplete;
  }
}

async function noteIncomplete(
  state: ReconcileTickState,
  ledger: TickLedger,
  log: ReconcileTickLog,
  alert: Omit<ReconcileIncompleteAlert, 'consecutiveIncomplete'>,
  extra: object,
  maxConsecutiveIncomplete: number,
): Promise<void> {
  state.consecutiveIncomplete += 1;
  const streak = await announcedStreak(state, ledger, log);
  const announced: ReconcileIncompleteAlert = { ...alert, consecutiveIncomplete: streak };
  try {
    await ledger.alertReconciliationIncomplete?.(announced);
  } catch (err) {
    log.fatal({ err }, ALERT_FAILED_LOG);
  }
  if (streak >= maxConsecutiveIncomplete) {
    try {
      await freezeAsReconciliation(ledger, RECONCILE_UNPROVEN_REASON);
    } catch (err) {
      // Do not back off away from a halt that did not land. The next tick retries.
      state.skipTicks = 0;
      throw err;
    }
    // Backoff stays on the in-memory count. The alert carries the larger streak.
    state.skipTicks = backoffTicks(state.consecutiveIncomplete);
    log.fatal({ ...extra, ...announced, skipNextTicks: state.skipTicks, frozenReason: RECONCILE_UNPROVEN_REASON }, UNPROVEN_LOG);
    return;
  }
  state.skipTicks = backoffTicks(state.consecutiveIncomplete);
  log.fatal({ ...extra, ...announced, skipNextTicks: state.skipTicks }, INCOMPLETE_LOG);
}

export async function runScheduledReconciliationTick(
  run: () => Promise<ScheduledReconcileResult>,
  ledger: TickLedger,
  log: ReconcileTickLog,
  options: ReconcileTickOptions = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const state = options.state ?? createReconcileTickState(now());
  const maxConsecutiveIncomplete =
    options.maxConsecutiveIncomplete === undefined
      ? DEFAULT_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE
      : validReconcileMaxConsecutiveIncomplete(options.maxConsecutiveIncomplete);

  if (state.skipTicks > 0) {
    state.skipTicks -= 1;
    log.info?.(
      { skipTicksLeft: state.skipTicks, consecutiveIncomplete: state.consecutiveIncomplete },
      'reconciliation tick skipped: backing off',
    );
  } else {
    let result: ScheduledReconcileResult | undefined;
    let thrown: unknown;
    try {
      result = await run();
    } catch (err) {
      thrown = err;
    }
    if (thrown !== undefined) {
      if (thrown instanceof LedgerError && thrown.code === 'ledger.reconcile_freeze_failed') {
        // A mismatch WAS found and the freeze after it did not land. This is the one
        // throw that must still try to halt posting. Not claiming a freeze unless it lands.
        await freezeAsReconciliation(ledger, RECONCILE_MISMATCH_REASON);
        log.fatal({ err: thrown }, FROZEN_LOG);
      } else {
        await noteIncomplete(
          state,
          ledger,
          log,
          { errorCode: reconcileErrorCode(thrown), phase: 'tick', runId: null },
          { outcome: 'incomplete', err: thrown },
          maxConsecutiveIncomplete,
        );
      }
    } else if (result?.outcome === 'ok') {
      state.consecutiveIncomplete = 0;
    } else if (result?.outcome === 'mismatch') {
      // Already frozen by the run. The page is this log line.
      log.fatal({ report: result.report, snapshotted: false }, FROZEN_LOG);
    } else if (result?.outcome === 'incomplete') {
      await noteIncomplete(
        state,
        ledger,
        log,
        { errorCode: result.run.errorCode, phase: result.run.phase, runId: result.run.runId },
        {
          outcome: 'incomplete',
          err: result.run.error,
          ...(result.run.recordError !== undefined ? { recordErr: result.run.recordError } : {}),
        },
        maxConsecutiveIncomplete,
      );
    }
    // 'skipped': another replica or the operator is proving the book. Say nothing, change nothing.
  }

  await reportWhenStale(ledger, log, state, options, now);

  if (ledger.runDueReconciliationControls) {
    try {
      await ledger.runDueReconciliationControls();
    } catch (err) {
      log.fatal({ err }, 'LEDGER RECONCILIATION CONTROLS TICK FAILED — posting unchanged');
    }
  }
}

/** Report every tick, including skipped ones, so backoff cannot hide stale evidence. */
async function reportWhenStale(
  ledger: TickLedger,
  log: ReconcileTickLog,
  state: ReconcileTickState,
  options: ReconcileTickOptions,
  now: () => Date,
): Promise<void> {
  if (!ledger.lastVerified) return;

  let last: LastVerified;
  try {
    last = await ledger.lastVerified();
  } catch (err) {
    // Cannot measure staleness: say so loudly, freeze nothing on a read failure.
    log.fatal({ err }, 'LEDGER RECONCILIATION STALENESS CHECK FAILED — last verified time unreadable');
    return;
  }

  log.info?.({ lastVerifiedAt: last.at?.toISOString() ?? null, lastVerifiedSeq: last.seq }, 'reconciliation last verified');

  if (options.maxStaleHours === undefined) return;
  // Never verified: measure from the first recorded attempt, else from this process's boot.
  const since = last.at ?? last.firstAttemptAt ?? state.bootedAt;
  const ageMs = now().getTime() - since.getTime();
  if (ageMs <= options.maxStaleHours * 3_600_000) return;

  log.fatal(
    {
      lastVerifiedAt: last.at?.toISOString() ?? null,
      lastVerifiedSeq: last.seq,
      staleSince: since.toISOString(),
      maxStaleHours: options.maxStaleHours,
    },
    STALE_LOG,
  );
}
