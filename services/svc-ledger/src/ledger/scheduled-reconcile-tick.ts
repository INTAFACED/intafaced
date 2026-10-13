import { LedgerError } from '@intafaced/ledger-client';
import type { ReconciliationReport } from './reconcile.js';

/**
 * Hourly timer seam.
 *
 * A returned failed report has already halted posting inside
 * `LedgerService.reconcile`. A throw never reached that halt: the timer used
 * to log and leave the process posting. The catch writes the same freeze —
 * reason `reconciliation mismatch`, actor `reconciliation` — and then the
 * same fatal page. No report, balance, or drift is invented for that page.
 * An operator freeze already standing is left standing (`ledger.freeze_attributed`).
 */

const FROZEN_LOG = 'LEDGER RECONCILIATION FAILED — posting frozen, operator paged';

/** Same attribution `LedgerService.reconcile` writes when a report comes back failed. */
const FREEZE_REASON = 'reconciliation mismatch';
const FREEZE_ACTOR = 'reconciliation';

export interface ReconcileTickLog {
  fatal(obj: object, msg: string): void;
}

interface TickLedger {
  freeze(reason: string, actor: string): Promise<unknown>;
  /** Present on `LedgerService`. A publish throw can land after the switch commits. */
  status?(): Promise<{ postingEnabled: boolean }>;
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

export async function runScheduledReconciliationTick(
  run: () => Promise<{ report: ReconciliationReport; snapshotted: boolean }>,
  ledger: TickLedger,
  log: ReconcileTickLog,
): Promise<void> {
  try {
    const { report, snapshotted } = await run();
    if (!report.ok) {
      log.fatal({ report, snapshotted }, FROZEN_LOG);
    }
  } catch (err) {
    try {
      await ledger.freeze(FREEZE_REASON, FREEZE_ACTOR);
    } catch (freezeErr) {
      // Same rule as `reconcile`: an operator halt stays. A publish failure
      // after the switch commits is also a halt. Anything else did not freeze
      // the book, so do not claim that it did.
      const attributed = freezeErr instanceof LedgerError && freezeErr.code === 'ledger.freeze_attributed';
      if (!attributed && !(await alreadyHalted(ledger))) throw freezeErr;
    }
    log.fatal({ err }, FROZEN_LOG);
  }
}
