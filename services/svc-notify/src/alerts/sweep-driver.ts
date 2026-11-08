/**
 * One mounted alert sweep pass — shared by the boot driver and the interval.
 *
 * The interval alone left active watches unevaluated for up to
 * `ALERT_SWEEP_INTERVAL_MS` after boot and made `/ready.sweep.lastAt` read as
 * "never ran" until the first tick. Both are the same Class B shape: evaluation
 * promised, first pass delayed.
 */

import type { AlertService, AlertSweepReport } from './service.js';
import type { WatchRuleService } from './watch-rules.js';

export type AlertSweepRecorder = {
  readonly onComplete: (report: AlertSweepReport, at: Date) => void;
  readonly onError: (err: unknown) => void;
};

export async function runAlertSweepPass(alerts: AlertService, recorder: AlertSweepRecorder, watchRules?: WatchRuleService): Promise<void> {
  // Watchlist alerts first, so a market added to a list since the last pass is evaluated in this one. A rule step that cannot
  // run is logged and the evaluation still runs: no alert already held waits on a watchlist read.
  if (watchRules) {
    try {
      await watchRules.sync();
    } catch (err) {
      recorder.onError(err);
    }
  }
  try {
    const report = await alerts.evaluateDueAlerts();
    recorder.onComplete(report, new Date());
  } catch (err) {
    recorder.onError(err);
  }
}
