import { LedgerError } from '@intafaced/ledger-client';
import type { LastVerified, ScheduledReconcileResult } from './reconcile.js';
import { RECONCILE_ACTOR, RECONCILE_MISMATCH_REASON } from './reconcile-config.js';

/**
 * Hourly timer seam.
 *
 * Only a COMPLETED proof that found a break freezes posting, and that freeze is
 * written by the snapshot runner's caller (`LedgerService.handleReconciliationMismatch`)
 * before the run returns. This tick therefore never freezes on a throw or on an
 * `incomplete` run: "the proof could not finish" is not "the book is wrong"
 * (issue #4755). An incomplete run is logged fatal and retried on a later tick
 * with backoff.
 *
 * Staleness is reported on every tick, including backoff. An old or absent
 * proof is still no verdict: staleness never changes the posting switch.
 */

const FROZEN_LOG = 'LEDGER RECONCILIATION FAILED — posting frozen, operator attention required';
const INCOMPLETE_LOG = 'LEDGER RECONCILIATION INCOMPLETE — the book was NOT verified and NOT frozen, operator attention required';
const STALE_LOG = 'LEDGER RECONCILIATION STALE — the book is NOT verified, posting unchanged, operator attention required';

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

function noteIncomplete(state: ReconcileTickState, log: ReconcileTickLog, detail: object): void {
  state.consecutiveIncomplete += 1;
  state.skipTicks = backoffTicks(state.consecutiveIncomplete);
  log.fatal({ ...detail, consecutiveIncomplete: state.consecutiveIncomplete, skipNextTicks: state.skipTicks }, INCOMPLETE_LOG);
}

export async function runScheduledReconciliationTick(
  run: () => Promise<ScheduledReconcileResult>,
  ledger: TickLedger,
  log: ReconcileTickLog,
  options: ReconcileTickOptions = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const state = options.state ?? createReconcileTickState(now());

  if (state.skipTicks > 0) {
    state.skipTicks -= 1;
    log.info?.(
      { skipTicksLeft: state.skipTicks, consecutiveIncomplete: state.consecutiveIncomplete },
      'reconciliation tick skipped: backing off',
    );
  } else {
    try {
      const result = await run();
      if (result.outcome === 'ok') {
        state.consecutiveIncomplete = 0;
      } else if (result.outcome === 'mismatch') {
        // Already frozen by the run. The page is this log line.
        log.fatal({ report: result.report, snapshotted: false }, FROZEN_LOG);
      } else if (result.outcome === 'incomplete') {
        noteIncomplete(state, log, {
          outcome: 'incomplete',
          phase: result.run.phase,
          errorCode: result.run.errorCode,
          runId: result.run.runId,
          err: result.run.error,
          ...(result.run.recordError !== undefined ? { recordErr: result.run.recordError } : {}),
        });
      }
      // 'skipped': another replica or the operator is proving the book. Say nothing, change nothing.
    } catch (err) {
      if (err instanceof LedgerError && err.code === 'ledger.reconcile_freeze_failed') {
        // A mismatch WAS found and the freeze after it did not land. This is the one
        // throw that must still try to halt posting. Not claiming a freeze unless it lands.
        await freezeAsReconciliation(ledger, RECONCILE_MISMATCH_REASON);
        log.fatal({ err }, FROZEN_LOG);
      } else {
        // Anything else is "no verdict": a bug or an infrastructure fault around the run.
        noteIncomplete(state, log, { outcome: 'incomplete', phase: 'tick', errorCode: 'unknown', err });
      }
    }
  }

  await reportWhenStale(ledger, log, state, options, now);
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
